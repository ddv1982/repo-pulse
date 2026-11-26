/** Resolve CI against the same event snapshot as the feed, before choosing visible rows. */
export const activityCi = `
  , runs AS MATERIALIZED (
    SELECT run.*,e.repo_id AS repo,e.imported,lower(json_extract(e.data,'$.data.sourceVersion')) AS sha,
      json_extract(e.data,'$.data.sourceBranch') AS ref,json_extract(e.data,'$.data.reason') AS reason,
      json_extract(e.data,'$.title') AS title,
      COALESCE(unixepoch(json_extract(e.data,'$.data.buildStartedAt'),'subsec')*1000,run.time) AS started
    FROM matched run JOIN events e ON e.id=run.representative
    WHERE run.kind='build' AND run.status IN ('succeeded','failed','partially-succeeded')
  ), candidates AS (
    SELECT run.key AS run_key,host.key AS host_key,1 AS priority,1 AS validation
    FROM runs run JOIN matched host ON host.representative=(
      SELECT pr.id FROM events pr JOIN matched milestone ON milestone.representative=pr.id
      WHERE pr.repo_id=run.repo AND json_extract(pr.data,'$.kind')='pr'
        AND CAST(json_extract(pr.data,'$.data.pullRequestId') AS TEXT)=substr(run.ref,11,length(run.ref)-16)
        AND json_extract(pr.data,'$.data.status')='active'
        AND pr.imported=run.imported AND milestone.time<=run.started
      ORDER BY milestone.time DESC,milestone.observed DESC,milestone.key DESC LIMIT 1
    )
    WHERE run.reason='pullRequest' AND run.ref GLOB 'refs/pull/[0-9]*/merge'
    UNION ALL
    SELECT run.key,host.key,2,0
    FROM runs run
    JOIN events pr ON pr.repo_id=run.repo AND json_extract(pr.data,'$.kind')='pr'
      AND json_extract(pr.data,'$.data.status')='completed' AND pr.imported=run.imported
      AND json_extract(pr.data,'$.data.targetRefName')=run.ref AND lower(json_extract(pr.data,'$.data.mergeCommit'))=run.sha
    JOIN matched host ON host.representative=pr.id AND host.time<=run.started
    WHERE run.ref GLOB 'refs/heads/*' AND run.reason IN ('individualCI','batchedCI')
    UNION ALL
    SELECT run.key,host.key,3,0
    FROM runs run JOIN push_tips tip ON tip.repo_id=run.repo AND tip.ref=run.ref AND tip.tip=run.sha
    JOIN matched host ON host.representative=tip.event_id AND host.kind='push' AND host.time<=run.started
    JOIN events push ON push.id=tip.event_id AND push.imported=run.imported
    WHERE run.ref GLOB 'refs/heads/*' AND run.reason IN ('individualCI','batchedCI')
      AND json_array_length(push.data,'$.data.refUpdates')=1
  ), ranked_candidates AS (
    SELECT *,DENSE_RANK() OVER (PARTITION BY run_key ORDER BY priority) AS preference,
      COUNT(*) OVER (PARTITION BY run_key,priority) AS matches,
      SUM(priority=3) OVER (PARTITION BY run_key) AS push_matches
    FROM candidates
  ), ci_links AS MATERIALIZED (
    SELECT run.key AS run_key,run.representative AS run_id,run.status,run.title,run.time AS run_time,host.key AS host_key,
      host.representative AS host_id,host.kind AS host_kind,candidate.validation,
      (run.status='succeeded') AS folded
    FROM ranked_candidates candidate JOIN runs run ON run.key=candidate.run_key
    JOIN matched host ON host.key=candidate.host_key
    WHERE candidate.preference=1 AND candidate.matches=1 AND candidate.push_matches<=1
  )`;
