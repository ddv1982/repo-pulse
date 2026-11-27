/**
 * Resolve CI against the pinned event snapshot before choosing visible rows.
 * Drive each host lookup from the run through the ref/PR indexes, then resolve its indexed membership.
 * Branch creation is evidence against a unique push match, but remains an independent row.
 */
export const activityCi = `
  , ci_snapshot AS (SELECT ? AS through), runs AS MATERIALIZED (
    SELECT run.*,e.repo_id AS repo,e.imported,lower(json_extract(e.data,'$.data.sourceVersion')) AS sha,
      json_extract(e.data,'$.data.sourceBranch') AS ref,json_extract(e.data,'$.data.reason') AS reason,
      json_extract(e.data,'$.data.buildStartedAt') AS started_at,
      CAST(json_extract(e.data,'$.data.definition.id') AS TEXT) AS pipeline,
      json_extract(e.data,'$.title') AS title,json_extract(e.data,'$.time') AS event_time,
      COALESCE(unixepoch(json_extract(e.data,'$.data.buildStartedAt'),'subsec')*1000,
        CASE WHEN json_type(e.data,'$.time') IN ('integer','real') THEN json_extract(e.data,'$.time') ELSE run.time END) AS started
    FROM matched run JOIN events e ON e.id=run.representative
    WHERE run.kind='build' AND run.status IN ('succeeded','failed','partially-succeeded','queued','running','canceling')
      AND json_extract(e.data,'$.data.sourceVersion')<>''
  ), validation_hosts AS (
    SELECT run.key AS run_key,host.group_key AS host_key,
      ROW_NUMBER() OVER (PARTITION BY run.key ORDER BY host.time DESC,host.observed DESC,host.event_id DESC) AS position
    FROM runs run
    CROSS JOIN events pr ON pr.repo_id=run.repo AND json_extract(pr.data,'$.kind')='pr'
      AND CAST(json_extract(pr.data,'$.data.pullRequestId') AS TEXT)=substr(run.ref,11,length(run.ref)-16)
      AND json_extract(pr.data,'$.data.status')='active' AND pr.imported=run.imported
      AND lower(json_extract(pr.data,'$.data.previewCommit'))=run.sha
    CROSS JOIN activity_members host ON host.event_id=pr.id AND host.sequence<=(SELECT through FROM ci_snapshot)
    WHERE run.reason='pullRequest' AND run.ref GLOB 'refs/pull/[0-9]*/merge'
      AND substr(run.ref,11,length(run.ref)-16) NOT GLOB '*[^0-9]*'
  ), candidates AS (
    SELECT run_key,host_key,1 AS priority,1 AS validation,1 AS eligible FROM validation_hosts WHERE position=1
    UNION ALL
    SELECT run.key,host.group_key,2,0,1
    FROM runs run
    CROSS JOIN events pr ON pr.repo_id=run.repo AND json_extract(pr.data,'$.kind')='pr'
      AND json_extract(pr.data,'$.data.status')='completed' AND pr.imported=run.imported
      AND json_extract(pr.data,'$.data.targetRefName')=run.ref AND lower(json_extract(pr.data,'$.data.mergeCommit'))=run.sha
    CROSS JOIN activity_members host ON host.event_id=pr.id AND host.sequence<=(SELECT through FROM ci_snapshot) AND host.time<=run.started
    WHERE run.ref GLOB 'refs/heads/*' AND run.reason IN ('individualCI','batchedCI')
    UNION ALL
    SELECT run.key,host.group_key,3,0,COALESCE(json_array_length(push.data,'$.data.refUpdates')=1,0)
    FROM runs run CROSS JOIN push_tips tip ON tip.repo_id=run.repo AND tip.ref=run.ref AND tip.tip=run.sha
    CROSS JOIN events push ON push.id=tip.event_id AND push.imported=run.imported
    CROSS JOIN activity_members host ON host.event_id=tip.event_id AND host.sequence<=(SELECT through FROM ci_snapshot)
      AND host.kind='push' AND host.time<=run.started
    WHERE run.ref GLOB 'refs/heads/*' AND run.reason IN ('individualCI','batchedCI')
    UNION ALL
    SELECT run.key,host.group_key,3,0,0
    FROM runs run
    CROSS JOIN events creation ON creation.repo_id=run.repo AND creation.imported=run.imported
      AND json_extract(creation.data,'$.kind') IN ('branch-created','branch-deleted')
      AND json_extract(creation.data,'$.kind')='branch-created' AND json_extract(creation.data,'$.data.evidence')='push'
      AND json_extract(creation.data,'$.data.name')=run.ref AND lower(json_extract(creation.data,'$.data.newObjectId'))=run.sha
    CROSS JOIN activity_members host ON host.event_id=creation.id AND host.sequence<=(SELECT through FROM ci_snapshot)
      AND host.time<=run.started
    WHERE run.ref GLOB 'refs/heads/*' AND run.reason IN ('individualCI','batchedCI')
  ), ranked_candidates AS (
    SELECT *,DENSE_RANK() OVER (PARTITION BY run_key ORDER BY priority) AS preference,
      COUNT(*) OVER (PARTITION BY run_key,priority) AS matches,
      SUM(priority=3) OVER (PARTITION BY run_key) AS push_matches
    FROM candidates
  ), ci_links AS MATERIALIZED (
    SELECT run.key AS run_key,run.representative AS run_id,run.status,run.title,run.event_time AS run_time,
      run.pipeline,run.sha,run.started_at,run.reason,
      CASE WHEN typeof(run.event_time) IN ('integer','real') THEN run.event_time
        ELSE COALESCE(unixepoch(run.event_time,'subsec')*1000,0) END AS run_ms,
      host.key AS host_key,
      host.representative AS host_id,host.kind AS host_kind,candidate.validation,
      (run.status='succeeded' AND run.unseen=0) AS folded
    FROM ranked_candidates candidate JOIN runs run ON run.key=candidate.run_key
    JOIN matched host ON host.key=candidate.host_key
    WHERE candidate.preference=1 AND candidate.matches=1 AND candidate.push_matches<=1 AND candidate.eligible
  )`;
