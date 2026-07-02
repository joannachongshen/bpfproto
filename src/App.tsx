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
const TASK_DUE_DATE_FIELD = 'usgs_requestedduedatefornexttask'

// How often (ms) to silently re-fetch so task updates appear without a manual
// reload. Also exposed as window.refreshWorkflowVisualizer() for the host form.
const REFRESH_INTERVAL_MS = 30000

// ---------------------------------------------------------------------------
// Stage visibility model.
//
// Which stages a record displays is driven by the BPF helper fields on the
// Information Product (peer-review / BAO / SPN / accepted-manuscript "skipped"
// flags) plus the live current BPF stage — NOT by a hardcoded workflow-group
// number. Each canonical stage belongs to one or more "chunks"; a chunk is shown
// or hidden as a unit based on the helper flags, so the visualizer renders only
// the path that actually applies to this record.
//
// Comment-reconciliation ("<Approval> - Address Comments") stages are NOT part
// of the canonical path. They are exception stages shown only when the record's
// current active stage is exactly that reconciliation stage.
// ---------------------------------------------------------------------------

// A chunk groups stages that are shown/hidden together. 'core' stages always
// show (except the direct-dissemination exception); the rest are gated by the
// BPF helper flags — see computeVisibility / isChunkVisible.
type StageChunk =
  | 'core'
  | 'peerReview'
  | 'spnEdit'
  | 'spnProduction'
  | 'bao'
  | 'acceptedManuscript'

// The full, ordered superset of non-reconciliation stages, in display order.
// Stage names must match usgs_workflowstage.usgs_name (compared
// case-insensitively). A stage shows when ANY of its chunks is visible (or it is
// 'core', or the record visited it / is currently on it). "SPN Production" is
// shared: it is the production step for both USGS-publication records
// (spnProduction chunk) and journal accepted-manuscript records
// (acceptedManuscript chunk), so it carries both chunks. The environment has no
// distinct "SPN Production of Accepted Manuscript" stage, so journals use this
// shared "SPN Production" as their accepted-manuscript production step.
const CANONICAL_PATH: { name: string; chunks: StageChunk[] }[] = [
  { name: 'Prepare Record', chunks: ['core'] },
  { name: 'Approve for Peer Review', chunks: ['peerReview'] },
  { name: 'Peer Review and Reconciliation', chunks: ['peerReview'] },
  { name: 'Approve for SPN Edit', chunks: ['spnEdit'] },
  { name: 'Prepare for SPN Edit', chunks: ['spnEdit'] },
  { name: 'Initial SPN Edit', chunks: ['spnEdit'] },
  { name: 'Response to SPN Edit', chunks: ['spnEdit'] },
  { name: 'SPN Edit Approval', chunks: ['spnEdit'] },
  { name: 'Supervisory Approval', chunks: ['core'] },
  { name: 'Center Approval', chunks: ['core'] },
  { name: 'BAO Approval', chunks: ['bao'] },
  { name: 'Upload accepted manuscript', chunks: ['acceptedManuscript'] },
  { name: 'Prepare for SPN Production', chunks: ['spnProduction'] },
  { name: 'SPN Production', chunks: ['spnProduction', 'acceptedManuscript'] },
  { name: 'Response to SPN Author Proof', chunks: ['spnProduction'] },
  { name: 'Web Citation Page', chunks: ['spnProduction'] },
  { name: 'Response to Web Citation Page', chunks: ['spnProduction'] },
  { name: 'Dissemination', chunks: ['core'] },
  { name: 'Disseminated', chunks: ['core'] },
]

// Core stages an extramural / direct-dissemination record still shows. For that
// path the approval stages (Supervisory, Center) are skipped entirely.
const DIRECT_DISSEMINATION_STAGES = new Set<string>([
  'prepare record',
  'dissemination',
  'disseminated',
])

// Resolved stage visibility for a single record, computed from the BPF helper
// fields plus the product type (for the SPN-type gate and the extramural
// direct-dissemination exception).
type StageVisibility = {
  showPeerReview: boolean
  showBaoApproval: boolean
  showSpnStages: boolean
  showAcceptedManuscript: boolean
  directDisseminationOnly: boolean
}

// True when the given chunk should be shown for a record with this visibility.
function isChunkVisible(chunk: StageChunk, visibility: StageVisibility): boolean {
  switch (chunk) {
    case 'core':
      return true
    case 'peerReview':
      return visibility.showPeerReview
    case 'spnEdit':
    case 'spnProduction':
      // One helper (usgs_bpfhelperspnskipped) governs BOTH SPN chunks together.
      return visibility.showSpnStages
    case 'bao':
      return visibility.showBaoApproval
    case 'acceptedManuscript':
      return visibility.showAcceptedManuscript
  }
}

// Extracts the parent approval-stage name from a comment-reconciliation stage
// name following the "<Approval Stage> - Address Comment(s)" convention, or null
// if the name isn't a comment-reconciliation stage. Used to position the
// reconciliation stage immediately after its related approval stage.
function addressCommentsParent(stageName: string): string | null {
  const match = stageName.match(/^(.*?)\s*-\s*address comments?$/i)
  return match ? match[1].trim() : null
}

// --- Field bindings --------------------------------------------------------
// Besides the BPF helper booleans, the only IP column the visibility logic needs
// is the product type — read from its lookup's formatted value. Visibility is
// driven entirely by the BPF helper fields (NOT by routing the record into a
// workflow group), so the old interpretive-content / special-alert / publication-
// outlet / open-access routing inputs are no longer read.
const PRODUCT_TYPE_FIELD = '_usgs_producttype_value'

// BPF helper (boolean) columns — the source of truth for which optional stage
// chunks apply to a record. Set by the IPDS Business Process Flow. Meaning of a
// `true` value:
//   peerReviewSkipped           -> hide the Peer Review stages
//   baoApprovalSkipped          -> hide the BAO Approval stage
//   spnSkipped                  -> hide BOTH SPN Edit and SPN Production stages
//   notOpenAccessJournalArticle -> SHOW the accepted-manuscript stages
// (usgs_bpfhelperproducttypename is intentionally NOT used for routing — the
// product type is read from the _usgs_producttype_value lookup instead.)
const BPF_HELPER_FIELDS = {
  peerReviewSkipped: 'usgs_bpfhelperpeerreviewskipped',
  baoApprovalSkipped: 'usgs_bpfhelperbaoapprovalskipped',
  spnSkipped: 'usgs_bpfhelperspnskipped',
  notOpenAccessJournalArticle: 'usgs_bpfhelpernotopenaccessjournalarticle',
} as const

// Columns read to compute stage visibility: the product type plus the BPF helper
// booleans.
const VISIBILITY_SELECT = [
  PRODUCT_TYPE_FIELD,
  ...Object.values(BPF_HELPER_FIELDS),
].join(',')

// Reads an option-set/lookup column as its display label when available, falling
// back to the raw stored value.
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

// --- Product-type gates ----------------------------------------------------
// Only two stage groups depend on the product type rather than purely on a BPF
// helper flag. Both are matched against the product type lookup's FORMATTED
// VALUE (not a workflow-group number). Compare case-insensitively; update these
// lists if the product-type labels in the environment change.

// Product types whose records can use the SPN Edit + SPN Production stages. The
// SPN stages still require usgs_bpfhelperspnskipped to be not-true; this gate
// just confirms the product type is a USGS series / nonseries publication.
const SPN_PRODUCT_TYPES = new Set<string>([
  'usgs series publication',
  'nonseries usgs publications',
  'circular',
])

function isSpnProductType(productTypeLabel: string): boolean {
  return SPN_PRODUCT_TYPES.has(productTypeLabel.trim().toLowerCase())
}

// Product types that disseminate directly, skipping the approval stages. This is
// the one confirmed direct-dissemination-only exception to "always show the core
// approval stages" (extramural-authored publications).
const DIRECT_DISSEMINATION_PRODUCT_TYPES = new Set<string>([
  'extramural-authored publication',
])

function isDirectDisseminationProductType(productTypeLabel: string): boolean {
  return DIRECT_DISSEMINATION_PRODUCT_TYPES.has(
    productTypeLabel.trim().toLowerCase(),
  )
}

// Computes stage visibility purely from the BPF helper booleans + product type.
// This is the SOLE source of truth for which optional stage chunks a record
// shows — there is NO workflow-group routing. Helper semantics: a "skipped" flag
// of true HIDES its stages; the not-open-access-journal-article flag of true
// SHOWS the accepted-manuscript stages. The SPN stages additionally require a
// USGS series / nonseries publication product type.
function computeVisibility(record: Record<string, unknown>): StageVisibility {
  const productTypeLabel = readLabel(record, PRODUCT_TYPE_FIELD)

  return {
    showPeerReview: !isTruthy(record[BPF_HELPER_FIELDS.peerReviewSkipped]),
    showBaoApproval: !isTruthy(record[BPF_HELPER_FIELDS.baoApprovalSkipped]),
    showSpnStages:
      !isTruthy(record[BPF_HELPER_FIELDS.spnSkipped]) &&
      isSpnProductType(productTypeLabel),
    showAcceptedManuscript: isTruthy(
      record[BPF_HELPER_FIELDS.notOpenAccessJournalArticle],
    ),
    directDisseminationOnly: isDirectDisseminationProductType(productTypeLabel),
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
  returned: { label: 'Needs attention', icon: 'attention' },
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

  console.groupCollapsed('[WorkflowVisualizer] fetchTaskHistory')
  console.log('xrm context present', !!xrm)
  console.log('formContext', formContext)

  if (!xrm || !formContext?.recordId) {
    console.log(
      'aborting: no Xrm context or no recordId — returning empty task history',
      { hasXrm: !!xrm, recordId: formContext?.recordId },
    )
    console.groupEnd()
    return { completionByStage, taskDetailByStage, visitedStages }
  }

  try {
    const query =
      `?$select=usgs_workflowtaskid,usgs_completeddate,usgs_comment,statuscode,_ownerid_value,${TASK_DUE_DATE_FIELD},` +
      '_usgs_workflowstagefrom_value,_usgs_workflowstageto_value' +
      `&$filter=_usgs_informationproductid_value eq ${formContext.recordId}`

    console.log('OData query (usgs_workflowtask)', query)

    const response = await xrm.WebApi.retrieveMultipleRecords<DataverseWorkflowTaskRow>(
      'usgs_workflowtask',
      query,
    )

    console.log('raw response.entities count', response.entities.length)
    console.log('raw response.entities', response.entities)

    for (const task of response.entities) {
      const fromStageId = asGuid(task._usgs_workflowstagefrom_value)
      const taskId = task.usgs_workflowtaskid

      console.log('processing task', {
        taskId,
        statuscode: task.statuscode,
        from: task._usgs_workflowstagefrom_value,
        to: task._usgs_workflowstageto_value,
        completedDate: task.usgs_completeddate,
      })

      if (!fromStageId || !taskId) {
        console.log('  skipping task — missing fromStageId or taskId', { fromStageId, taskId })
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

        if (!toStageId || !completedDate) {
          console.log(
            '[WorkflowVisualizer] visitedStages: skipping task — missing toStageId or completedDate',
            { taskId, fromStageId: key, toStageId, completedDate, statuscode: task.statuscode },
          )
          continue
        }

        visitedStages.add(key)
        console.log('[WorkflowVisualizer] visitedStages.add (from stage)', key, 'set now:', [...visitedStages])
        visitedStages.add(toStageId.toLowerCase())
        console.log('[WorkflowVisualizer] visitedStages.add (to stage)', toStageId.toLowerCase(), 'set now:', [...visitedStages])

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
          console.log('  recorded completion for from-stage', key, { completedDate, ownerName, dueDate })
        } else {
          console.log('  kept existing (newer) completion for from-stage', key, { existing, thisDate: completedDate })
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
          console.log('  active task — recorded assignee detail for stage', key, { ownerName, dueDate, statuscode: task.statuscode })
        } else {
          console.log('  active task — skipped, finalized completion already exists for stage', key)
        }
      }
    }
  } catch (error) {
    // Leave the maps empty — stages still render, just unfiltered and undated.
    console.warn('[WorkflowVisualizer] fetchTaskHistory failed', error)
  }

  // visitedStages is fully populated here (all finalized tasks processed). Log
  // both the Set and an array snapshot — some consoles render Sets unhelpfully.
  console.log('result: visitedStages (array)', [...visitedStages])
  console.log('result: completionByStage', Object.fromEntries(completionByStage))
  console.log('result: taskDetailByStage', Object.fromEntries(taskDetailByStage))
  console.groupEnd()

  return { completionByStage, taskDetailByStage, visitedStages }
}

function asGuid(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/[{}]/g, '') : undefined
}

async function fetchRecordWorkflow(): Promise<{
  stageId?: string
  workflowId?: string
  visibility?: StageVisibility | null
  isLegacy?: boolean
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
      '?$select=_usgs_workflowstageid_value,_usgs_workflowid_value,usgs_legacymigration',
    )

    const stageId = asGuid(record['_usgs_workflowstageid_value'])
    const isLegacy = isTruthy(record['usgs_legacymigration'])

    // The IP carries the workflow lookup directly. Migrated legacy records may
    // leave it empty, so fall back to the workflow on the current stage record.
    let workflowId = asGuid(record['_usgs_workflowid_value'])
    if (!workflowId && stageId) {
      try {
        const stageRec = await xrm.WebApi.retrieveRecord(
          'usgs_workflowstage',
          stageId,
          '?$select=_usgs_workflow_value',
        )
        workflowId = asGuid(stageRec['_usgs_workflow_value'])
      } catch {
        // Stage lookup unavailable; leave workflowId undefined.
      }
    }

    const visibility = await fetchVisibility(xrm, formContext)

    return { stageId, workflowId, visibility, isLegacy }
  } catch {
    return {}
  }
}

// Reads the IP record's BPF helper fields + product type and computes stage
// visibility. Kept in a separate, independently-guarded request so that a bad
// field binding only disables filtering — the stage list still renders. Returns
// null on failure, which drives the strict fallback in buildStageViewModels.
async function fetchVisibility(
  xrm: XrmContext,
  formContext: FormContext,
): Promise<StageVisibility | null> {
  try {
    const record = await xrm.WebApi.retrieveRecord(
      formContext.entityName,
      formContext.recordId,
      `?$select=${VISIBILITY_SELECT}`,
    )

    // --- Visibility diagnostics -----------------------------------------------
    // Logs every object the visibility pipeline consumes/produces so the show/
    // hide decisions can be traced in the browser console. One collapsible entry.
    console.groupCollapsed('[WorkflowVisualizer] visibility')
    console.log('formContext', formContext)
    console.log('visibility fields ($select)', VISIBILITY_SELECT.split(','))
    // The product type + BPF helper columns off the raw IP record, including the
    // formatted (label) annotations Dataverse returns alongside the raw values.
    const rawFields: Record<string, unknown> = {}
    for (const logicalName of [PRODUCT_TYPE_FIELD, ...Object.values(BPF_HELPER_FIELDS)]) {
      rawFields[logicalName] = record[logicalName]
      const formattedKey = `${logicalName}@OData.Community.Display.V1.FormattedValue`
      if (formattedKey in record) {
        rawFields[formattedKey] = record[formattedKey]
      }
    }
    console.log('raw product type + BPF helper fields off record', rawFields)
    console.log('full record', record)
    console.log('product type (formatted value)', readLabel(record, PRODUCT_TYPE_FIELD))

    const visibility = computeVisibility(record)
    console.log('computed visibility', visibility)
    console.groupEnd()

    return visibility
  } catch (error) {
    console.warn('[WorkflowVisualizer] visibility computation failed', error)
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

// Inserts a stage into an already-ordered list at the position implied by its
// global sequence number (before the first stage with a greater sequence). Used
// for off-path stages that DON'T follow the "Address Comments" naming convention
// (e.g. an optional BAO Approval the record was routed to) — their global
// sequence sits correctly between the surrounding approval stages.
function insertByGlobalSequence(placed: WorkflowStage[], stage: WorkflowStage): void {
  let insertAt = placed.length
  for (let i = 0; i < placed.length; i++) {
    if (placed[i].sequenceNumber > stage.sequenceNumber) {
      insertAt = i
      break
    }
  }
  placed.splice(insertAt, 0, stage)
}

// Builds the ordered list of stages to DISPLAY for a record. Walks the canonical
// path in order and includes a stage when ANY of its chunks is visible per the
// BPF helper flags, OR the record actually landed on it (visited / current) — so
// completed stages always stay visible even if their chunk would otherwise be
// hidden. Comment-reconciliation ("<Approval> - Address Comments") stages are NOT
// in the canonical path: each is shown ONLY if the record actually landed on it
// (the specific approver's reconciliation stage), grafted in immediately after
// its parent approval stage; reconciliation stages the record never reached stay
// hidden. Extramural / direct-dissemination records show only the direct path
// (Prepare Record -> Dissemination -> Disseminated), skipping the approvals.
function buildHelperDrivenDisplay(
  stages: WorkflowStage[],
  visibility: StageVisibility,
  currentStage: WorkflowStage | undefined,
  visited: (stage: WorkflowStage) => boolean,
): WorkflowStage[] {
  const byName = new Map<string, WorkflowStage>()
  for (const stage of stages) {
    const key = stage.stageName.toLowerCase()
    if (!byName.has(key)) {
      byName.set(key, stage)
    }
  }

  const currentNameLower = currentStage?.stageName.toLowerCase()
  const placed: WorkflowStage[] = []
  const placedIds = new Set<string>()

  // Walk the canonical path in order; include each stage whose chunk applies or
  // that the record actually landed on (so completed stages stay visible).
  for (const entry of CANONICAL_PATH) {
    const nameLower = entry.name.toLowerCase()
    const stage = byName.get(nameLower)
    if (!stage || placedIds.has(stage.id)) {
      continue
    }

    const landedOn = nameLower === currentNameLower || visited(stage)

    // Direct-dissemination (extramural) records skip the approval stages unless
    // the record actually landed on one.
    if (
      visibility.directDisseminationOnly &&
      !DIRECT_DISSEMINATION_STAGES.has(nameLower) &&
      !landedOn
    ) {
      continue
    }

    const chunkVisible = entry.chunks.some((chunk) => isChunkVisible(chunk, visibility))
    if (chunkVisible || landedOn) {
      placed.push(stage)
      placedIds.add(stage.id)
    }
  }

  // Graft in the off-path stages the record actually landed on (visited or
  // current) — primarily comment-reconciliation stages. Only the specific
  // reconciliation stage(s) the record reached appear; the rest stay hidden.
  // Each reconciliation stage is placed immediately after its parent approval
  // stage (its global sequence is unreliable); any other off-path stage is
  // positioned by global sequence. Sorted by sequence so multiple extras keep a
  // stable order.
  const offPathLanded = stages
    .filter(
      (stage) =>
        !placedIds.has(stage.id) &&
        (visited(stage) || stage.stageName.toLowerCase() === currentNameLower),
    )
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber)

  for (const stage of offPathLanded) {
    if (placedIds.has(stage.id)) {
      continue
    }
    const parent = addressCommentsParent(stage.stageName)
    if (parent) {
      const parentLower = parent.toLowerCase()
      const parentIndex = placed.findIndex(
        (placedStage) => placedStage.stageName.toLowerCase() === parentLower,
      )
      if (parentIndex === -1) {
        insertByGlobalSequence(placed, stage)
      } else {
        // Insert after the parent and after any sibling reconciliation stages
        // already placed directly after it.
        let insertAt = parentIndex + 1
        while (
          insertAt < placed.length &&
          addressCommentsParent(placed[insertAt].stageName)?.toLowerCase() === parentLower
        ) {
          insertAt++
        }
        placed.splice(insertAt, 0, stage)
      }
    } else {
      insertByGlobalSequence(placed, stage)
    }
    placedIds.add(stage.id)
  }

  return placed
}

function buildStageViewModels(
  stages: WorkflowStage[],
  currentSequence: number | null,
  completionByStage: Map<string, string>,
  taskDetailByStage: Map<string, TaskDetail>,
  visitedStages: Set<string>,
  visibility: StageVisibility | null,
  isLegacy: boolean,
): StageViewModel[] {
  const visited = (stage: WorkflowStage) => visitedStages.has(stage.id.toLowerCase())
  const isCurrent = (stage: WorkflowStage) =>
    currentSequence !== null && stage.sequenceNumber === currentSequence
  const currentStage = stages.find(isCurrent)

  console.groupCollapsed('[WorkflowVisualizer] buildStageViewModels')
  console.log('input: currentSequence', currentSequence)
  console.log('input: currentStage', currentStage?.stageName)
  console.log('input: visitedStages', [...visitedStages])
  console.log('input: visibility', visibility)
  console.log('input: isLegacy', isLegacy)

  // Decide which stages to display, and in what order.
  let display: WorkflowStage[]
  if (visibility && !isLegacy) {
    // Helper-driven: render only the chunks that apply to this record, in
    // canonical order. The BPF helper flags are the source of truth, so stages
    // that don't apply (e.g. "Upload accepted manuscript" on an abstract) are
    // never shown — but stages the record actually landed on stay visible.
    display = buildHelperDrivenDisplay(stages, visibility, currentStage, visited)
  } else {
    // Legacy record, or visibility couldn't be read: don't guess optional
    // stages. Show the core stages plus whatever the record actually visited or
    // is currently on — never the whole shared catalog.
    const strict: StageVisibility = {
      showPeerReview: false,
      showBaoApproval: false,
      showSpnStages: false,
      showAcceptedManuscript: false,
      directDisseminationOnly: false,
    }
    display = buildHelperDrivenDisplay(stages, strict, currentStage, visited)
  }

  // Status is positional within the display list — NOT global sequence.
  const currentIndex = display.findIndex(isCurrent)
  const maxVisitedIndex = display.reduce(
    (max, stage, index) => (visited(stage) ? Math.max(max, index) : max),
    -1,
  )

  const result: StageViewModel[] = display.map((stage, index) => {
    let status: StageStatus
    if (currentIndex === -1) {
      // No resolved current stage: anything visited is completed, rest upcoming.
      status = visited(stage) ? 'completed' : 'upcoming'
    } else if (index < currentIndex) {
      status = 'completed'
    } else if (index === currentIndex) {
      // The record sits earlier than the furthest stage it reached => it was
      // sent back here => "returned" (needs attention). Otherwise in progress.
      status = currentIndex < maxVisitedIndex ? 'returned' : 'inProgress'
    } else {
      status = 'upcoming'
    }

    const key = stage.id.toLowerCase()
    const taskDetail = status !== 'upcoming' ? taskDetailByStage.get(key) : undefined

    return {
      ...stage,
      status,
      isCurrent: isCurrent(stage),
      completedOn:
        status === 'completed' ? formatDate(completionByStage.get(key)) : undefined,
      taskId: taskDetail?.taskId,
      comment: taskDetail?.comment,
      ownerName: taskDetail?.ownerName,
      ownerId: taskDetail?.ownerId,
      ownerEntityType: taskDetail?.ownerEntityType,
      dueDate: taskDetail?.dueDate,
    }
  })

  console.log(
    'output: visible stages',
    result.map((s) => ({ name: s.stageName, status: s.status, isCurrent: s.isCurrent })),
  )
  console.groupEnd()

  return result
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
      {iconType === 'attention' && (
        <svg viewBox="0 0 20 20" focusable="false">
          <path d="M9 4h2v7H9z" />
          <path d="M9 13.2h2v2.2H9z" />
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
  const [visibility, setVisibility] = useState<StageVisibility | null>(null)
  const [isLegacy, setIsLegacy] = useState(false)
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
      const [
        { stageId, workflowId, visibility: nextVisibility, isLegacy: nextIsLegacy },
        taskHistory,
      ] = await Promise.all([fetchRecordWorkflow(), fetchTaskHistory()])

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
      setVisibility(nextVisibility ?? null)
      setIsLegacy(nextIsLegacy ?? false)
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
        visibility,
        isLegacy,
      ),
    [stages, currentSequence, completionByStage, taskDetailByStage, visitedStages, visibility, isLegacy],
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
