import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

type StageStatus = 'completed' | 'inProgress' | 'upcoming'

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
}

declare global {
  interface Window {
    Xrm?: XrmContext
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
  // Side pane (navigateTo) delivers the record context as a single URL-encoded
  // `data` query string parameter.
  const data = new URLSearchParams(window.location.search).get('data')

  if (data) {
    const params = new URLSearchParams(data)
    const entityName = params.get('entityName') ?? ''
    const recordId = (params.get('recordId') ?? '').replace(/[{}]/g, '')

    if (entityName || recordId) {
      return { entityName, recordId }
    }
  }

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
function formatCompletedDate(value: string | null | undefined): string | undefined {
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
      '?$select=usgs_workflowtaskid,usgs_completeddate,usgs_comment,statuscode,_ownerid_value,' +
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

    return { stageId, workflowId }
  } catch {
    return {}
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
): StageViewModel[] {
  return stages
    .map((stage) => {
      const status =
        currentSequence === null
          ? 'upcoming'
          : getStageStatus(stage.sequenceNumber, currentSequence)

      const key = stage.id.toLowerCase()
      const taskDetail =
        status === 'completed' || status === 'inProgress'
          ? taskDetailByStage.get(key)
          : undefined

      return {
        ...stage,
        status,
        isCurrent: stage.sequenceNumber === currentSequence,
        completedOn:
          status === 'completed'
            ? formatCompletedDate(completionByStage.get(key))
            : undefined,
        taskId: taskDetail?.taskId,
        comment: taskDetail?.comment,
        ownerName: taskDetail?.ownerName,
        ownerId: taskDetail?.ownerId,
        ownerEntityType: taskDetail?.ownerEntityType,
      }
    })
    .filter(
      (stage) =>
        stage.status !== 'completed' ||
        visitedStages.has(stage.id.toLowerCase()),
    )
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

  useEffect(() => {
    let active = true

    async function loadStages() {
      try {
        setLoadState('loading')
        setSourceLabel('Loading workflow stages.')

        const [{ stageId, workflowId }, taskHistory] = await Promise.all([
          fetchRecordWorkflow(),
          fetchTaskHistory(),
        ])

        if (!active) {
          return
        }

        if (!workflowId) {
          setSourceLabel(
            'No workflow is associated with this record. Set the workflow stage to visualize the workflow.',
          )
          setLoadState('error')
          return
        }

        setCurrentWorkflowId(workflowId)

        const { rows: nextRows, source } = await fetchWorkflowStages(workflowId)

        if (!active) {
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
        setSourceLabel(source)
        setLoadState('ready')
      } catch (error) {
        if (!active) {
          return
        }

        setSourceLabel(
          error instanceof Error
            ? error.message
            : 'Dataverse did not return workflow stages.',
        )
        setLoadState('error')
      }
    }

    loadStages()

    return () => {
      active = false
    }
  }, [])

  const stageViewModels = useMemo(
    () =>
      buildStageViewModels(
        stages,
        currentSequence,
        completionByStage,
        taskDetailByStage,
        visitedStages,
      ),
    [stages, currentSequence, completionByStage, taskDetailByStage, visitedStages],
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
                    <div
                      className="stepHeader"
                      onClick={() => toggleStage(stage.id)}
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleStage(stage.id)
                        }
                      }}
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
                    </div>

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
