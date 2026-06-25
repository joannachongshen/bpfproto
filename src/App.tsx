import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type StageStatus = 'completed' | 'inProgress' | 'upcoming' | 'returned'

type LoadState = 'loading' | 'ready' | 'error'

type WorkflowStage = {
  id: string
  stage: string
  stageName: string
  sequenceNumber: number
  description: string
  workflowName: string
  workflowDescription: string
}

type TaskDetail = {
  taskId: string
  comment?: string
  ownerName?: string
  ownerId?: string
  ownerEntityType?: string
  dueDate?: string
}

type DataverseWorkflowStageRow = {
  usgs_workflowstageid?: string
  usgs_stage: string
  usgs_name: string
  usgs_sequencenumber: number
  usgs_description?: string
  usgs_Workflow?: {
    usgs_workflowid?: string
    usgs_name?: string
    usgs_description?: string
    usgs_stagescount?: number
  }
}

type DataverseWorkflowTaskRow = {
  usgs_workflowtaskid?: string
  usgs_completeddate?: string | null
  usgs_comment?: string | null
  statuscode?: number
  _usgs_workflowstagefrom_value?: string | null
  _usgs_workflowstageto_value?: string | null
  _ownerid_value?: string | null
}

type FormContext = {
  entityName: string
  recordId: string
}

type StageViewModel = WorkflowStage & {
  status: StageStatus
  isCurrent: boolean
  completedOn?: string
  taskId?: string
  comment?: string
  ownerName?: string
  ownerId?: string
  ownerEntityType?: string
  dueDate?: string
}

type XrmWebApi = {
  retrieveMultipleRecords: <T = Record<string, unknown>>(
    entityLogicalName: string,
    options?: string,
  ) => Promise<{ entities: T[] }>
  retrieveRecord: (
    entityLogicalName: string,
    id: string,
    options?: string,
  ) => Promise<Record<string, unknown>>
}

type XrmNavigation = {
  navigateTo: (
    pageInput: { pageType: 'entityrecord'; entityName: string; entityId: string },
    navigationOptions?: { target: 1 | 2 },
  ) => Promise<void>
}

// Side panes are owned by the top-level app window, so this is read from the
// host (parent) Xrm rather than the iframe's own Xrm.
type XrmSidePane = {
  close: () => void
}

type XrmApp = {
  sidePanes?: {
    getPane?: (paneId: string) => XrmSidePane | undefined
  }
}

// Supported replacement for the deprecated Xrm.Page: reports the page currently
// shown in the app's main area and updates as the user navigates.
type XrmUtility = {
  getPageContext?: () => {
    input?: { pageType?: string; entityName?: string; entityId?: string }
  } | undefined
}

// Form context exposed by the host page when this resource is embedded directly
// on a form (Xrm.Page is deprecated but remains the only way for an independently
// loaded web resource to read the form's current record).
type XrmFormEntity = {
  getId?: () => string
  getEntityName?: () => string
}

type XrmPage = {
  data?: {
    entity?: XrmFormEntity
  }
}

type XrmContext = {
  WebApi: XrmWebApi
  Navigation?: XrmNavigation
  Page?: XrmPage
  App?: XrmApp
  Utility?: XrmUtility
}

declare global {
  interface Window {
    Xrm?: XrmContext
    // Exposed by the visualizer so the host form's JavaScript can force a
    // refresh (e.g. from a task subgrid OnSave handler) without a page reload.
    refreshWorkflowVisualizer?: () => void
  }
}

// The entity this resource is meant to accompany. When the host form moves to
// any other entity (or no record at all), the side pane should close itself.
const INFORMATION_PRODUCT_ENTITY = 'usgs_informationproduct'
const SIDE_PANE_ID = 'WorkflowVisualizationPane'

// ---------------------------------------------------------------------------
// Deployment configuration — adjust to match the Dataverse schema and data.
// ---------------------------------------------------------------------------

// Logical (schema) name of the "requested due date" column on usgs_workflowtask.
// Change this if the column is named differently in your environment.
const TASK_DUE_DATE_FIELD = 'usgs_requestduedate'

// How often (ms) to silently re-fetch so task updates appear without a manual
// reload. Also exposed as window.refreshWorkflowVisualizer() for the host form.
const REFRESH_INTERVAL_MS = 30000

// Stages that are NOT part of the standard forward path — comment reconciliation
// and address-comments stages. They are hidden unless the record was actually
// routed through them. Matched (case-insensitive) against the stage name. Note
// the standard "Peer Review and Reconciliation" stage is intentionally NOT
// matched. A dedicated boolean column on usgs_workflowstage would be more robust
// than name matching; see the accompanying notes.
const OFF_PATH_STAGE_PATTERNS: RegExp[] = [
  /comment reconciliation/i,
  /address comments/i,
  /^reconciliation\b/i,
]

function isOffPathStage(stageName: string): boolean {
  return OFF_PATH_STAGE_PATTERNS.some((pattern) => pattern.test(stageName))
}

// ---------------------------------------------------------------------------
// Workflow group determination. There is no stored "group" column on the IP
// record; the group is computed in code from the general-tab fields the user
// selects (product type, interpretive content, special product alert,
// publication outlet, peer-review/open-access flags), following the IPDS routing
// rules — see determineGroup(). The computed group selects one of GROUP_PATHS.
// ---------------------------------------------------------------------------

// Canonical workflow paths per group, transcribed from the approved IPDS
// workflow configuration spreadsheet. These are the ONLY stages a record in a
// given group can display (plus any stage it has actually visited). Stage names
// must match usgs_workflowstage.usgs_name (compared case-insensitively).
// Update these lists whenever the IPDS spreadsheet changes.
const GROUP_PATHS: Record<string, string[]> = {
  '1': [
    'Prepare Record',
    'Supervisory Approval',
    'Center Approval',
    'BAO Approval',
    'Dissemination',
  ],
  '2': [
    'Prepare Record',
    'Approve for Peer Review',
    'Peer Review and Reconciliation',
    'Supervisory Approval',
    'Center Approval',
    'Dissemination',
  ],
  '3': [
    'Prepare Record',
    'Approve for Peer Review',
    'Peer Review and Reconciliation',
    'Supervisory Approval',
    'Center Approval',
    'BAO Approval',
    'Dissemination',
  ],
  '4': [
    'Prepare Record',
    'Approve for Peer Review',
    'Peer Review and Reconciliation',
    'Supervisory Approval',
    'Center Approval',
    'BAO Approval',
    'Upload Accepted Manuscript',
    'SPN Production of Accepted Manuscript',
    'Dissemination',
  ],
  '5': ['Prepare Record', 'Dissemination'],
  '6': [
    'Prepare Record',
    'Approve for Peer Review',
    'Peer Review and Reconciliation',
    'Approve for SPN Edit',
    'Prepare for SPN Edit',
    'Initial SPN Edit',
    'Response to SPN Edit',
    'SPN Edit Approval',
    'Supervisory Approval',
    'Center Approval',
    'Prepare for SPN Production',
    'SPN Production',
    'Response to SPN Author Proof',
    'Web Citation Page',
    'Response to Web Citation Page',
    'Dissemination',
  ],
  '7': [
    'Prepare Record',
    'Approve for Peer Review',
    'Peer Review and Reconciliation',
    'Approve for SPN Edit',
    'Prepare for SPN Edit',
    'Initial SPN Edit',
    'Response to SPN Edit',
    'SPN Edit Approval',
    'Supervisory Approval',
    'Center Approval',
    'BAO Approval',
    'Prepare for SPN Production',
    'SPN Production',
    'Response to SPN Author Proof',
    'Web Citation Page',
    'Response to Web Citation Page',
    'Dissemination',
  ],
}

// Returns the ordered stage-name set for a group key (lowercased for matching),
// or null for an unknown/absent key.
function groupPathSet(groupKey: string | null): Set<string> | null {
  if (!groupKey) {
    return null
  }
  const path = GROUP_PATHS[groupKey]
  return path ? new Set(path.map((name) => name.toLowerCase())) : null
}

// --- Field bindings (PLACEHOLDERS) -----------------------------------------
// Logical names of the usgs_informationproduct columns that drive routing.
// REPLACE these with the real schema names from your environment. The routing
// logic in determineGroup() is complete and does not change — only these
// bindings and the value comparisons in readWorkflowInputs() do.
const IP_FIELDS = {
  productType: 'usgs_producttype',
  // Interpretive content: "low" = noninterpretive OR interpretive based on
  // previously approved products; "new" = contains new interpretive content.
  interpretiveContent: 'usgs_interpretivecontent',
  specialProductAlert: 'usgs_specialproductalert',
  publicationOutlet: 'usgs_publicationoutlet',
  peerReviewRequired: 'usgs_peerreviewrequired',
  openAccess: 'usgs_openaccess',
} as const

// Every column the determination logic reads, for the IP $select.
const IP_ROUTING_SELECT = Object.values(IP_FIELDS).join(',')

type ProductCategory =
  | 'simpleOptionalPeerReview' // Abstract or summary, Poster or presentation, USGS web page
  | 'newsMedia' // Science news article, news release, social media, blog, etc.
  | 'standardPublication' // Atlas, Book, Map (non-USGS series), Thesis, etc.
  | 'dataSoftware' // Data release, Software release, Geonarrative, online DB / web data service
  | 'journal' // Journal or periodical article
  | 'alwaysGroup3' // Book review, Technical comment and reply, Preprint
  | 'usgsPublication' // USGS series publications, Nonseries USGS publications
  | 'extramural' // Extramural publication

// Maps each product-type value to a routing category. Keys are the
// usgs_producttype values in YOUR environment (option-set labels are read via
// the OData formatted value, so human-readable keys like 'Atlas' work). REPLACE
// the placeholder keys with the real values; the categories on the right are
// correct per the IPDS rules and should not need changing.
const PRODUCT_TYPE_CATEGORY: Record<string, ProductCategory> = {
  // 'Abstract or summary': 'simpleOptionalPeerReview',
  // 'Poster or presentation': 'simpleOptionalPeerReview',
  // 'USGS web page': 'simpleOptionalPeerReview',
  // 'Science news article': 'newsMedia',
  // 'News release': 'newsMedia',
  // 'Social media, audiovisual product, or blog': 'newsMedia',
  // 'Atlas': 'standardPublication',
  // 'Book, book chapter, encyclopedia entry, or guidebook': 'standardPublication',
  // 'Map (non-USGS series)': 'standardPublication',
  // 'Thesis': 'standardPublication',
  // 'Data Release': 'dataSoftware',
  // 'Software release': 'dataSoftware',
  // 'USGS Geonarrative': 'dataSoftware',
  // 'Journal or periodical article': 'journal',
  // 'Book review, technical comment and reply': 'alwaysGroup3',
  // 'Preprint': 'alwaysGroup3',
  // 'USGS series publications': 'usgsPublication',
  // 'Nonseries USGS publications': 'usgsPublication',
  // 'Extramural publication': 'extramural',
}

type WorkflowInputs = {
  productCategory: ProductCategory | null
  contentInterpretive: 'low' | 'new' | null
  specialProductAlert: boolean
  publicationOutlet: 'nonScientificNewsMedia' | 'scienceOutlet' | null
  peerReviewRequired: boolean
  openAccess: boolean
}

// Reads an option-set/lookup column as its display label when available (so the
// maps above can use readable values), falling back to the raw stored value.
function readLabel(record: Record<string, unknown>, logicalName: string): string {
  const formatted =
    record[`${logicalName}@OData.Community.Display.V1.FormattedValue`]
  return String(formatted ?? record[logicalName] ?? '')
}

function isTruthy(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    /^(true|yes)$/i.test(String(value ?? ''))
  )
}

// Reads the routing inputs off the saved IP record. The value comparisons below
// are PLACEHOLDERS — adjust them to your option-set labels/values.
function readWorkflowInputs(record: Record<string, unknown>): WorkflowInputs {
  const productCategory =
    PRODUCT_TYPE_CATEGORY[readLabel(record, IP_FIELDS.productType)] ?? null

  const interpretive = readLabel(record, IP_FIELDS.interpretiveContent)
  const contentInterpretive: 'low' | 'new' | null =
    interpretive === '' ? null : /new/i.test(interpretive) ? 'new' : 'low'

  const outlet = readLabel(record, IP_FIELDS.publicationOutlet)
  const publicationOutlet: WorkflowInputs['publicationOutlet'] =
    outlet === ''
      ? null
      : /scien/i.test(outlet)
        ? 'scienceOutlet'
        : 'nonScientificNewsMedia'

  // Treat a Special Product Alert as present when the field is set to anything
  // other than empty / "None" (handles both an option set and a yes/no field).
  const alert = readLabel(record, IP_FIELDS.specialProductAlert)
  const specialProductAlert = alert !== '' && !/^(none|no)$/i.test(alert)

  return {
    productCategory,
    contentInterpretive,
    specialProductAlert,
    publicationOutlet,
    peerReviewRequired: isTruthy(record[IP_FIELDS.peerReviewRequired]),
    openAccess: isTruthy(record[IP_FIELDS.openAccess]),
  }
}

// Applies the IPDS routing rules to pick a group ('1'..'7'), or null when it
// can't be determined yet (e.g. product type not selected). This encodes the
// business rules; keep it aligned with the IPDS routing spreadsheet.
function determineGroup(input: WorkflowInputs): string | null {
  // New interpretive content or a Special Product Alert escalate the overlapping
  // product types from their optional-BAO group to the required-BAO group.
  const escalate = input.contentInterpretive === 'new' || input.specialProductAlert

  switch (input.productCategory) {
    case 'extramural':
      return '5'

    case 'alwaysGroup3':
      return '3'

    case 'dataSoftware':
      return '2'

    case 'journal':
      // Open access -> Group 3; otherwise the non-open-access journal path.
      return input.openAccess ? '3' : '4'

    case 'simpleOptionalPeerReview':
      return input.peerReviewRequired ? '2' : '1'

    case 'newsMedia':
      // Scientific outlet, special alert, or new interpretive content escalate to
      // the required-BAO group; otherwise non-scientific media path keyed by PR.
      if (input.publicationOutlet === 'scienceOutlet' || escalate) {
        return '3'
      }
      return input.peerReviewRequired ? '2' : '1'

    case 'standardPublication':
      return escalate ? '3' : '2'

    case 'usgsPublication':
      return escalate ? '7' : '6'

    default:
      return null
  }
}

function buildStagesQuery(workflowId: string): string {
  return [
    '?$select=_usgs_stage_value,usgs_sequencenumber,usgs_description,usgs_name',
    '&$expand=usgs_Workflow($select=usgs_name,usgs_description,usgs_stagescount)',
    `&$filter=_usgs_workflow_value eq ${workflowId}`,
    '&$orderby=usgs_sequencenumber',
  ].join('')
}

const statusContent: Record<StageStatus, { label: string; icon: string }> = {
  completed: { label: 'Completed', icon: 'check' },
  inProgress: { label: 'In progress', icon: 'progress' },
  upcoming: { label: 'Upcoming', icon: 'upcoming' },
  returned: { label: 'Returned', icon: 'progress' },
}

function getXrmContext(): XrmContext | undefined {
  if (window.Xrm?.WebApi) {
    return window.Xrm
  }

  try {
    return window.parent?.Xrm?.WebApi ? window.parent.Xrm : undefined
  } catch {
    return undefined
  }
}

function getFormContext(): FormContext | undefined {
  // // Side pane (navigateTo) delivers the record context as a single URL-encoded
  // // `data` query string parameter.
  // const data = new URLSearchParams(window.location.search).get('data')

  // if (data) {
  //   const params = new URLSearchParams(data)
  //   const entityName = params.get('entityName') ?? ''
  //   const recordId = (params.get('recordId') ?? '').replace(/[{}]/g, '')

  //   if (entityName || recordId) {
  //     return { entityName, recordId }
  //   }
  // }

  // Embedded directly on a form: read the host form's current record instead.
  return getHostFormContext()
}

// Reads the record context from the host form when this resource is embedded on
// a form (no `data` query parameter). The form context lives on the parent
// window's Xrm.Page; the iframe's own Xrm has WebApi but no form. Falls back to
// self in case the host injects Xrm.Page directly.
function getHostFormContext(): FormContext | undefined {
  const candidates: (XrmContext | undefined)[] = []

  try {
    candidates.push(window.parent?.Xrm)
  } catch {
    // Cross-origin parent access can throw; ignore and try self.
  }
  candidates.push(window.Xrm)

  for (const xrm of candidates) {
    const entity = xrm?.Page?.data?.entity

    if (!entity) {
      continue
    }

    const entityName = entity.getEntityName?.() ?? ''
    const recordId = (entity.getId?.() ?? '').replace(/[{}]/g, '')

    if (entityName || recordId) {
      return { entityName, recordId }
    }
  }

  return undefined
}

// Returns the host (parent app) Xrm that owns the side panes. Falls back to the
// iframe's own Xrm if the parent is unreachable (e.g. cross-origin).
function getHostXrm(): XrmContext | undefined {
  try {
    if (window.parent?.Xrm) {
      return window.parent.Xrm
    }
  } catch {
    // Cross-origin parent access can throw; fall back to self.
  }
  return window.Xrm
}

// The page that currently fills the app's main area. `pageType` distinguishes a
// record form ('entityrecord') from a view/grid ('entitylist'), which both carry
// the same `etn`, so it is needed to tell "on the record" from "on the list".
type MainPage = { entityName?: string; pageType?: string }

// Reports the page currently shown in the app's main area, used to decide when
// the side pane should close. Xrm.Page can't be used here: it is a deprecated
// global that caches the last-opened form and keeps returning that entity even
// after the user navigates to a view, dashboard, or different record. We use the
// supported getPageContext() API, falling back to the main-window URL (its
// `etn`/`pagetype` query params track navigation) if that API is unavailable.
function getMainPage(): MainPage {
  // Preferred: supported current-page API on the host Xrm.
  try {
    const input = getHostXrm()?.Utility?.getPageContext?.()?.input
    if (input?.entityName) {
      return { entityName: input.entityName, pageType: input.pageType }
    }
  } catch {
    // getPageContext can throw when no page is active; fall through to the URL.
  }

  // Fallback: the app shell URL. Same-origin, so top/parent are readable.
  const frames: (Window | undefined)[] = []
  try {
    frames.push(window.top ?? undefined)
  } catch {
    // Cross-origin access can throw; skip this frame.
  }
  try {
    frames.push(window.parent ?? undefined)
  } catch {
    // Cross-origin access can throw; skip this frame.
  }

  for (const frame of frames) {
    if (!frame) {
      continue
    }

    try {
      const fromSearch = readMainPageFromParams(
        new URLSearchParams(frame.location.search),
      )
      if (fromSearch) {
        return fromSearch
      }

      // Some navigations carry the params in the hash instead of the query.
      const fromHash = readMainPageFromParams(
        new URLSearchParams(frame.location.hash.replace(/^#/, '')),
      )
      if (fromHash) {
        return fromHash
      }
    } catch {
      // Cross-origin frame; skip.
    }
  }

  return {}
}

// Pulls the page descriptor out of a parsed URL query/hash, or undefined when no
// entity is present (e.g. a dashboard or home page).
function readMainPageFromParams(params: URLSearchParams): MainPage | undefined {
  const entityName = params.get('etn')
  if (!entityName) {
    return undefined
  }

  return { entityName, pageType: params.get('pagetype') ?? undefined }
}

// True only when the app's main area is showing a usgs_informationproduct record
// form. A view/list of the same entity (pageType 'entitylist') returns false, so
// the side pane closes when the user leaves the record itself.
function isOnInformationProductRecord(): boolean {
  const page = getMainPage()
  return (
    page.entityName === INFORMATION_PRODUCT_ENTITY &&
    page.pageType === 'entityrecord'
  )
}

// Closes the workflow side pane if it is still open. Safe to call repeatedly.
function closeWorkflowPane() {
  try {
    const pane = getHostXrm()?.App?.sidePanes?.getPane?.(SIDE_PANE_ID)
    pane?.close()
  } catch {
    // Pane may already be gone or the API unavailable; nothing to close.
  }
}

async function fetchWorkflowStages(workflowId: string): Promise<{
  rows: DataverseWorkflowStageRow[]
  source: string
}> {
  const xrm = getXrmContext()

  if (!xrm) {
    throw new Error(
      'Dataverse context is unavailable. Host this web resource in a model-driven app so Xrm.WebApi can run the OData query.',
    )
  }

  const response = await xrm.WebApi.retrieveMultipleRecords<DataverseWorkflowStageRow>(
    'usgs_workflowstage',
    buildStagesQuery(workflowId),
  )

  return { rows: response.entities, source: 'Dataverse OData query' }
}

// Formats a Dataverse date string to mm/dd/yyyy. Reads the leading YYYY-MM-DD
// directly (no Date parsing) to avoid timezone shifts on date-only values.
function formatDate(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length < 10) {
    return undefined
  }

  const [year, month, day] = value.slice(0, 10).split('-')
  return year && month && day ? `${month}/${day}/${year}` : undefined
}

// Reads all tasks for this record to reconstruct the path it actually took.
// Finalized tasks (statuscode 2) populate completionByStage, visitedStages, and
// taskDetailByStage. Active tasks (any other statuscode) populate taskDetailByStage
// for the in-progress stage so the assignee is visible there too.
async function fetchTaskHistory(): Promise<{
  completionByStage: Map<string, string>
  taskDetailByStage: Map<string, TaskDetail>
  visitedStages: Set<string>
}> {
  const completionByStage = new Map<string, string>()
  const taskDetailByStage = new Map<string, TaskDetail>()
  const visitedStages = new Set<string>()
  const xrm = getXrmContext()
  const formContext = getFormContext()

  if (!xrm || !formContext?.recordId) {
    return { completionByStage, taskDetailByStage, visitedStages }
  }

  try {
    const query =
      `?$select=usgs_workflowtaskid,usgs_completeddate,usgs_comment,statuscode,_ownerid_value,${TASK_DUE_DATE_FIELD},` +
      '_usgs_workflowstagefrom_value,_usgs_workflowstageto_value' +
      `&$filter=_usgs_informationproductid_value eq ${formContext.recordId}`

    const response = await xrm.WebApi.retrieveMultipleRecords<DataverseWorkflowTaskRow>(
      'usgs_workflowtask',
      query,
    )

    for (const task of response.entities) {
      const fromStageId = asGuid(task._usgs_workflowstagefrom_value)
      const taskId = task.usgs_workflowtaskid

      if (!fromStageId || !taskId) {
        continue
      }

      // Xrm.WebApi includes OData annotations automatically in the response.
      const raw = task as unknown as Record<string, unknown>
      const ownerName = raw['_ownerid_value@OData.Community.Display.V1.FormattedValue'] as
        | string
        | undefined
      const ownerId = asGuid(task._ownerid_value)
      const ownerEntityType = raw[
        '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname'
      ] as string | undefined
      const dueDate = formatDate(raw[TASK_DUE_DATE_FIELD] as string | undefined)

      const key = fromStageId.toLowerCase()

      if (task.statuscode === 2) {
        // Finalized task: records the completion of its From stage.
        const toStageId = asGuid(task._usgs_workflowstageto_value)
        const completedDate = task.usgs_completeddate

        if (!toStageId || !completedDate) continue

        visitedStages.add(key)
        visitedStages.add(toStageId.toLowerCase())

        const existing = completionByStage.get(key)
        if (!existing || completedDate > existing) {
          completionByStage.set(key, completedDate)
          taskDetailByStage.set(key, {
            taskId,
            comment: task.usgs_comment ?? undefined,
            ownerName,
            ownerId,
            ownerEntityType,
            dueDate,
          })
        }
      } else {
        // Active task: show assignee on the in-progress stage. Finalized task
        // for the same From stage (if any) takes precedence.
        if (!completionByStage.has(key)) {
          taskDetailByStage.set(key, {
            taskId,
            comment: task.usgs_comment ?? undefined,
            ownerName,
            ownerId,
            ownerEntityType,
            dueDate,
          })
        }
      }
    }
  } catch {
    // Leave the maps empty — stages still render, just unfiltered and undated.
  }

  return { completionByStage, taskDetailByStage, visitedStages }
}

function asGuid(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/[{}]/g, '') : undefined
}

async function fetchRecordWorkflow(): Promise<{
  stageId?: string
  workflowId?: string
  groupPath?: Set<string> | null
}> {
  const xrm = getXrmContext()
  const formContext = getFormContext()

  if (!xrm || !formContext?.entityName || !formContext?.recordId) {
    return {}
  }

  try {
    const record = await xrm.WebApi.retrieveRecord(
      formContext.entityName,
      formContext.recordId,
      '?$select=_usgs_workflowstageid_value' +
        '&$expand=usgs_WorkflowStageId($select=_usgs_workflow_value)',
    )

    const stageId = asGuid(record['_usgs_workflowstageid_value'])
    const stage = record['usgs_WorkflowStageId'] as
      | Record<string, unknown>
      | null
      | undefined
    const workflowId = asGuid(stage?.['_usgs_workflow_value'])
    const groupPath = await fetchGroupPath(xrm, formContext)

    return { stageId, workflowId, groupPath }
  } catch {
    return {}
  }
}

// Reads the IP record's routing fields and computes its group path. Kept in a
// separate, independently-guarded request so that an incorrect field-binding
// (the IP_FIELDS placeholders) only disables grouping — the stage list still
// renders, just unfiltered by group.
async function fetchGroupPath(
  xrm: XrmContext,
  formContext: FormContext,
): Promise<Set<string> | null> {
  try {
    const record = await xrm.WebApi.retrieveRecord(
      formContext.entityName,
      formContext.recordId,
      `?$select=${IP_ROUTING_SELECT}`,
    )
    return groupPathSet(determineGroup(readWorkflowInputs(record)))
  } catch {
    return null
  }
}

function normalizeWorkflowStages(rows: DataverseWorkflowStageRow[]): WorkflowStage[] {
  return rows
    .map((row) => ({
      id:
        row.usgs_workflowstageid ??
        `${row.usgs_Workflow?.usgs_workflowid ?? 'workflow'}-${row.usgs_sequencenumber}`,
      stage: row.usgs_stage,
      stageName: row.usgs_name,
      sequenceNumber: row.usgs_sequencenumber,
      description: row.usgs_description ?? '',
      workflowName: row.usgs_Workflow?.usgs_name ?? 'Workflow',
      workflowDescription: row.usgs_Workflow?.usgs_description ?? '',
    }))
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber)
}

function getStageStatus(sequenceNumber: number, current: number): StageStatus {
  if (sequenceNumber < current) {
    return 'completed'
  }

  if (sequenceNumber === current) {
    return 'inProgress'
  }

  return 'upcoming'
}

function buildStageViewModels(
  stages: WorkflowStage[],
  currentSequence: number | null,
  completionByStage: Map<string, string>,
  taskDetailByStage: Map<string, TaskDetail>,
  visitedStages: Set<string>,
  groupPath: Set<string> | null,
): StageViewModel[] {
  // Whether we have any task history to trust. With no history (e.g. a migrated
  // legacy record) we show the full canonical path and never hide stages as
  // "skipped" — we don't try to reconstruct what actually happened.
  const hasTaskHistory = visitedStages.size > 0
  // Highest sequence the record has actually reached. When the current stage is
  // earlier than this, the record was returned to an earlier point in the path.
  const maxVisitedSequence = stages.reduce(
    (max, stage) =>
      visitedStages.has(stage.id.toLowerCase())
        ? Math.max(max, stage.sequenceNumber)
        : max,
    0,
  )

  return stages
    .map((stage) => {
      const baseStatus =
        currentSequence === null
          ? 'upcoming'
          : getStageStatus(stage.sequenceNumber, currentSequence)

      // Flag the active stage as "returned" when the record previously advanced
      // past it and was sent back here.
      const status: StageStatus =
        baseStatus === 'inProgress' &&
        currentSequence !== null &&
        currentSequence < maxVisitedSequence
          ? 'returned'
          : baseStatus

      const key = stage.id.toLowerCase()
      const taskDetail =
        status === 'completed' || status === 'inProgress' || status === 'returned'
          ? taskDetailByStage.get(key)
          : undefined

      return {
        ...stage,
        status,
        isCurrent: stage.sequenceNumber === currentSequence,
        completedOn:
          status === 'completed'
            ? formatDate(completionByStage.get(key))
            : undefined,
        taskId: taskDetail?.taskId,
        comment: taskDetail?.comment,
        ownerName: taskDetail?.ownerName,
        ownerId: taskDetail?.ownerId,
        ownerEntityType: taskDetail?.ownerEntityType,
        dueDate: taskDetail?.dueDate,
      }
    })
    .filter((stage) => {
      const visited = visitedStages.has(stage.id.toLowerCase())
      const inGroupPath = groupPath
        ? groupPath.has(stage.stageName.toLowerCase())
        : null

      // Restrict to the record's group path. Stages outside it are shown only
      // when the record actually visited them (e.g. a Comment Reconciliation
      // detour) or is currently on them. When the group is unknown (inGroupPath
      // null) fall back to the off-path name rules below.
      if (inGroupPath === false && !visited && !stage.isCurrent) {
        return false
      }

      // Hide optional/path stages the record skipped: completed by sequence but
      // never actually landed on (e.g. BAO Approval skipped by the Center
      // Approver). Only applies when we have task history to trust.
      if (hasTaskHistory && stage.status === 'completed' && !visited) {
        return false
      }

      // Fallback when the group is unknown: hide off-path stages (comment
      // reconciliation / address comments) unless visited or current.
      if (
        inGroupPath === null &&
        isOffPathStage(stage.stageName) &&
        !visited &&
        !stage.isCurrent
      ) {
        return false
      }

      return true
    })
}

function navigateToRecord(entityName: string, entityId: string) {
  const xrm = getXrmContext()
  if (!xrm?.Navigation) return

  void xrm.Navigation.navigateTo(
    { pageType: 'entityrecord', entityName, entityId },
    { target: 1 },
  )
}

function StatusIcon({ status }: { status: StageStatus }) {
  const iconType = statusContent[status].icon

  return (
    <span className="statusIcon" aria-hidden="true">
      {iconType === 'check' && (
        <svg viewBox="0 0 20 20" focusable="false">
          <path d="m7.6 13.8-3.4-3.4 1.4-1.4 2 2 5.8-5.8 1.4 1.4-7.2 7.2Z" />
        </svg>
      )}
      {iconType === 'progress' && (
        <svg viewBox="0 0 20 20" focusable="false">
          <path d="M10 3a7 7 0 1 0 7 7h-2a5 5 0 1 1-5-5V3Z" />
          <path d="M11 3v7h6a7 7 0 0 0-6-7Z" />
        </svg>
      )}
      {iconType === 'upcoming' && (
        <svg viewBox="0 0 20 20" focusable="false">
          <path d="M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
        </svg>
      )}
    </span>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <span
      className={`expandChevron${expanded ? ' expandChevron--open' : ''}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16" focusable="false">
        <path
          d="M4 6l4 4 4-4"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

function PersonIcon() {
  return (
    <svg className="personIcon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <circle cx="10" cy="7" r="3" />
      <path d="M4 17c0-3.3 2.7-6 6-6s6 2.7 6 6h-1.5c0-2.5-2-4.5-4.5-4.5S5.5 14.5 5.5 17z" />
    </svg>
  )
}

function OpenInNewIcon() {
  return (
    <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <path d="M12 4h4v4l-1.5-1.5-4.5 4.5-1-1 4.5-4.5z" />
      <path d="M10 5H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-4h-1.5V14H6.5V6.5H10z" />
    </svg>
  )
}

function CommentBadge() {
  return (
    <svg className="commentBadge" viewBox="0 0 16 16" focusable="false" aria-label="Has comment">
      <path d="M2 1h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-2 2.5L5 10H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" />
    </svg>
  )
}

function App() {
  const [rows, setRows] = useState<DataverseWorkflowStageRow[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [sourceLabel, setSourceLabel] = useState('Loading workflow stages.')
  const stages = useMemo(() => normalizeWorkflowStages(rows), [rows])
  const [currentSequence, setCurrentSequence] = useState<number | null>(null)
  const [currentWorkflowId, setCurrentWorkflowId] = useState<string | null>(null)
  const [completionByStage, setCompletionByStage] = useState<Map<string, string>>(
    () => new Map(),
  )
  const [taskDetailByStage, setTaskDetailByStage] = useState<Map<string, TaskDetail>>(
    () => new Map(),
  )
  const [visitedStages, setVisitedStages] = useState<Set<string>>(() => new Set())
  const [groupPath, setGroupPath] = useState<Set<string> | null>(null)
  const [expandedStageIds, setExpandedStageIds] = useState<Set<string>>(() => new Set())
  const [formContext] = useState<FormContext | undefined>(() => getFormContext())

  const toggleStage = useCallback((id: string) => {
    setExpandedStageIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Fetches the record's workflow, stages, and task history and updates state.
  // `silent` suppresses the "no workflow"/error states on background refreshes
  // so a transient failure leaves the existing data on screen. The first load
  // shows the loading state via the initial loadState/sourceLabel values.
  const loadStages = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false

    try {
      const [{ stageId, workflowId, groupPath: nextGroupPath }, taskHistory] =
        await Promise.all([fetchRecordWorkflow(), fetchTaskHistory()])

      if (!mountedRef.current) {
        return
      }

      if (!workflowId) {
        if (!silent) {
          setSourceLabel(
            'No workflow is associated with this record. Set the workflow stage to visualize the workflow.',
          )
          setLoadState('error')
        }
        return
      }

      setCurrentWorkflowId(workflowId)

      const { rows: nextRows, source } = await fetchWorkflowStages(workflowId)

      if (!mountedRef.current) {
        return
      }

      const currentRow = stageId
        ? nextRows.find(
            (row) =>
              row.usgs_workflowstageid?.toLowerCase() === stageId.toLowerCase(),
          )
        : undefined

      setRows(nextRows)
      setCurrentSequence(currentRow?.usgs_sequencenumber ?? null)
      setCompletionByStage(taskHistory.completionByStage)
      setTaskDetailByStage(taskHistory.taskDetailByStage)
      setVisitedStages(taskHistory.visitedStages)
      setGroupPath(nextGroupPath ?? null)
      setSourceLabel(source)
      setLoadState('ready')
    } catch (error) {
      if (!mountedRef.current || silent) {
        return
      }

      setSourceLabel(
        error instanceof Error
          ? error.message
          : 'Dataverse did not return workflow stages.',
      )
      setLoadState('error')
    }
  }, [])

  // Initial load. The state updates happen asynchronously after the Dataverse
  // fetch resolves, not synchronously in the effect body, so the cascading-render
  // concern the rule guards against does not apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch on mount
    void loadStages()
  }, [loadStages])

  // Keep the visualizer current after task updates: re-fetch on a fixed interval
  // and whenever the host form calls window.refreshWorkflowVisualizer() (e.g.
  // from a task subgrid's OnSave). Both run silently to avoid UI flicker.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadStages({ silent: true })
    }, REFRESH_INTERVAL_MS)

    window.refreshWorkflowVisualizer = () => {
      void loadStages({ silent: true })
    }

    return () => {
      window.clearInterval(intervalId)
      delete window.refreshWorkflowVisualizer
    }
  }, [loadStages])

  // The side pane has no "form close" event, so poll the app's main area every
  // 5 seconds. The pane stays only while a usgs_informationproduct *record form*
  // is open; navigating to its view/list, another entity, or no record at all
  // closes it. Reads the live main-window URL rather than the stale Xrm.Page.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!isOnInformationProductRecord()) {
        closeWorkflowPane()
      }
    }, 5000)

    return () => window.clearInterval(intervalId)
  }, [])

  const stageViewModels = useMemo(
    () =>
      buildStageViewModels(
        stages,
        currentSequence,
        completionByStage,
        taskDetailByStage,
        visitedStages,
        groupPath,
      ),
    [stages, currentSequence, completionByStage, taskDetailByStage, visitedStages, groupPath],
  )

  const currentStage = stages.find((stage) => stage.sequenceNumber === currentSequence)

  return (
    <main className="appShell">
      <section className="commandBar" aria-labelledby="workflow-title" hidden>
        <div className="workflowIntro">
          <p className="eyebrow">USGS model-driven app resource v2</p>
          <h1 id="workflow-title">{stages[0]?.workflowName ?? 'Workflow'}</h1>
          <p>
            {stages[0]?.workflowDescription ??
              'Workflow stages are loaded from Dataverse.'}
          </p>
          <p className="sourceNotice" aria-live="polite">
            {sourceLabel}
          </p>
        </div>
      </section>

      <section className="workflowCanvas" aria-labelledby="stepper-title">
        <div className="sectionHeader">
          <div>
            <p className="eyebrow">{stages[0]?.workflowDescription}</p>
            <h2 id="stepper-title">{stages[0]?.workflowName}</h2>
            <p className="formContextNotice" hidden>
              {formContext
                ? `${formContext.entityName} · ${formContext.recordId || 'unsaved record'}`
                : 'No form context — open this resource from a record form.'}
            </p>
          </div>
          <div className="routeMeta" aria-label="Route details" hidden>
            <span>Current: {currentStage?.stage ?? 'Loading'}</span>
          </div>
        </div>

        {loadState === 'error' && (
          <div className="emptyState" role="alert">
            <h3>Unable to load workflow stages</h3>
            <p>{sourceLabel}</p>
          </div>
        )}

        {loadState !== 'error' && (
          <ol
            className="stepper"
            aria-busy={loadState === 'loading'}
            aria-label="Workflow stages"
          >
            {stageViewModels.map((stage) => {
              const isExpanded = expandedStageIds.has(stage.id)
              const hasDetails =
                !!stage.description ||
                !!stage.comment ||
                !!stage.ownerName ||
                !!stage.dueDate ||
                !!stage.taskId

              return (
                <li
                  className="step"
                  data-status={stage.status}
                  key={stage.id}
                  aria-current={stage.isCurrent ? 'step' : undefined}
                >
                  <div className="stepRail" aria-hidden="true"></div>
                  <div className="stepMarker">
                    <StatusIcon status={stage.status} />
                  </div>
                  <div className="stepContent">
                    <button
                      type="button"
                      className="stepHeader"
                      onClick={() => toggleStage(stage.id)}
                      aria-expanded={isExpanded}
                    >
                      <div className="stepHeaderMain">
                        <div className="stageTitleRow">
                          <span className="statusPill">
                            {statusContent[stage.status].label}
                          </span>
                        </div>
                        <h3>{stage.stageName}</h3>
                        {stage.completedOn && (
                          <p className="completedText">
                            {stage.completedOn}
                            {stage.comment && <CommentBadge />}
                          </p>
                        )}
                      </div>
                      {hasDetails && <ChevronIcon expanded={isExpanded} />}
                    </button>

                    {isExpanded && hasDetails && (
                      <div className="stageDetails">
                        {stage.description && (
                          <p className="stageDescription">{stage.description}</p>
                        )}
                        <div className="detailMeta">
                          <div className="detailMetaLeft">
                            {stage.ownerName && (
                              <span className="detailUserLine">
                                <PersonIcon />
                                {stage.ownerId && stage.ownerEntityType ? (
                                  <button
                                    className="ownerLink"
                                    onClick={() =>
                                      navigateToRecord(
                                        stage.ownerEntityType!,
                                        stage.ownerId!,
                                      )
                                    }
                                  >
                                    {stage.ownerName}
                                  </button>
                                ) : (
                                  <span>{stage.ownerName}</span>
                                )}
                              </span>
                            )}
                            {stage.dueDate && (
                              <span className="detailDueLine">
                                Due {stage.dueDate}
                              </span>
                            )}
                            {stage.comment && (
                              <p className="taskComment">{stage.comment}</p>
                            )}
                          </div>
                          {stage.taskId && (
                            <button
                              className="openTaskIconBtn"
                              title="Open task record"
                              onClick={() => navigateToRecord('usgs_workflowtask', stage.taskId!)}
                            >
                              <OpenInNewIcon />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <aside className="supportingGrid" aria-label="Implementation notes" hidden>
        <div className="legend" aria-label="Status legend">
          {Object.entries(statusContent).map(([status, content]) => (
            <div className="legendItem" data-status={status} key={status}>
              <StatusIcon status={status as StageStatus} />
              <span>{content.label}</span>
            </div>
          ))}
        </div>

        <details className="fetchPanel">
          <summary>OData query source</summary>
          <pre>{buildStagesQuery(currentWorkflowId ?? '{workflow-id}')}</pre>
        </details>
      </aside>
    </main>
  )
}

export default App
