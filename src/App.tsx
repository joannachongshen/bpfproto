import { useEffect, useMemo, useState } from 'react'
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

type DataverseWorkflowStageRow = {
  usgs_workflowstageid?: string
  usgs_stage: string
  usgs_name: string
  usgs_sequencenumber: number
  usgs_description?: string
  // Parent workflow, returned nested via $expand=usgs_Workflow.
  usgs_Workflow?: {
    usgs_workflowid?: string
    usgs_name?: string
    usgs_description?: string
    usgs_stagescount?: number
  }
}

type FormContext = {
  entityName: string
  recordId: string
}

type StageViewModel = WorkflowStage & {
  status: StageStatus
  isCurrent: boolean
  completedOn?: string
}

type DataverseWorkflowTaskRow = {
  usgs_completeddate?: string | null
  statuscode?: number
  _usgs_workflowstagefrom_value?: string | null
  _usgs_workflowstageto_value?: string | null
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

type XrmContext = {
  WebApi: XrmWebApi
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
  // navigateTo / pane.navigate delivers our custom fields as a single
  // URL-encoded `data` query string parameter, not as top-level params.
  const data = new URLSearchParams(window.location.search).get('data')

  if (!data) {
    return undefined
  }

  const params = new URLSearchParams(data)
  const entityName = params.get('entityName') ?? ''
  const recordId = (params.get('recordId') ?? '').replace(/[{}]/g, '')

  if (!entityName && !recordId) {
    return undefined
  }

  return { entityName, recordId }
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

// Reads this record's finalized tasks (statuscode 2) to reconstruct the path it
// actually took. Returns:
//  - completionByStage: stage GUID -> completed date, keyed by the task's "From"
//    stage (finalizing a task completes its From stage on that date).
//  - visitedStages: every stage the record genuinely passed through (the From
//    and To of each finalized transition). Stages not in this set were skipped.
async function fetchTaskHistory(): Promise<{
  completionByStage: Map<string, string>
  visitedStages: Set<string>
}> {
  const completionByStage = new Map<string, string>()
  const visitedStages = new Set<string>()
  const xrm = getXrmContext()
  const formContext = getFormContext()

  if (!xrm || !formContext?.recordId) {
    return { completionByStage, visitedStages }
  }

  try {
    const query =
      '?$select=usgs_completeddate,_usgs_workflowstagefrom_value,_usgs_workflowstageto_value' +
      `&$filter=_usgs_informationproductid_value eq ${formContext.recordId}` +
      ' and statuscode eq 2'

    const response = await xrm.WebApi.retrieveMultipleRecords<DataverseWorkflowTaskRow>(
      'usgs_workflowtask',
      query,
    )

    for (const task of response.entities) {
      const fromStageId = asGuid(task._usgs_workflowstagefrom_value)
      const toStageId = asGuid(task._usgs_workflowstageto_value)
      const completedDate = task.usgs_completeddate

      if (!toStageId || !fromStageId || !completedDate) {
        continue
      }

      // Both endpoints of a finalized transition were actually visited.
      visitedStages.add(fromStageId.toLowerCase())
      visitedStages.add(toStageId.toLowerCase())

      // The From stage is the one completed by this task; key the date by it.
      // Keep the most recent completion if a stage was left more than once.
      const key = fromStageId.toLowerCase()
      const existing = completionByStage.get(key)
      if (!existing || completedDate > existing) {
        completionByStage.set(key, completedDate)
      }
    }
  } catch {
    // Leave the maps empty — stages still render, just unfiltered and undated.
  }

  return { completionByStage, visitedStages }
}

function asGuid(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/[{}]/g, '') : undefined
}

// Resolves the record's workflow context in a single retrieve: the record's
// usgs_workflowstageid lookup gives the current stage, and expanding that
// lookup's own usgs_workflow lookup gives the parent workflow used to filter
// the stage list. Returns empties if context is missing, the lookup is unset,
// or the retrieve fails — the visualization degrades gracefully.
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
  visitedStages: Set<string>,
): StageViewModel[] {
  return stages
    .map((stage) => {
      const status =
        currentSequence === null
          ? 'upcoming'
          : getStageStatus(stage.sequenceNumber, currentSequence)

      return {
        ...stage,
        status,
        isCurrent: stage.sequenceNumber === currentSequence,
        completedOn:
          status === 'completed'
            ? formatCompletedDate(completionByStage.get(stage.id.toLowerCase()))
            : undefined,
      }
    })
    .filter(
      (stage) =>
        // Past stages: keep only those the task history actually visited.
        // Current and upcoming stages are always shown.
        stage.status !== 'completed' ||
        visitedStages.has(stage.id.toLowerCase()),
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
  const [visitedStages, setVisitedStages] = useState<Set<string>>(() => new Set())
  // Query string is fixed for the lifetime of the resource, so read it once.
  const [formContext] = useState<FormContext | undefined>(() => getFormContext())

  useEffect(() => {
    let active = true

    async function loadStages() {
      try {
        setLoadState('loading')
        setSourceLabel('Loading workflow stages.')

        // Resolve the record's workflow and its completed-task dates together;
        // both depend only on the record, not on the stage list.
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

        // Map the record's current stage GUID to its sequence number.
        const currentRow = stageId
          ? nextRows.find(
              (row) =>
                row.usgs_workflowstageid?.toLowerCase() ===
                stageId.toLowerCase(),
            )
          : undefined

        setRows(nextRows)
        setCurrentSequence(currentRow?.usgs_sequencenumber ?? null)
        setCompletionByStage(taskHistory.completionByStage)
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
        visitedStages,
      ),
    [stages, currentSequence, completionByStage, visitedStages],
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
            {stageViewModels.map((stage) => (
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
                  <div className="stageTitleRow">
                    <span className="stageNumber">
                      Stage {stage.sequenceNumber}
                    </span>
                    <span className="statusPill">
                      {stage.completedOn
                        ? `Completed On ${stage.completedOn}`
                        : statusContent[stage.status].label}
                    </span>
                  </div>
                  <h3>{stage.stageName}</h3>
                  <p>{stage.description}</p>
                  {/* <div className="stageTags" aria-label="Stage markers">
                    {stage.isCurrent && <span>Current location</span>}
                  </div> */}
                </div>
              </li>
            ))}
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
