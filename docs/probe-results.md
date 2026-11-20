# Coverage probe results

Recorded 2026-11-20 by `scripts/probe-coverage.js` for 1 watched repositories. GET requests only. Repositories are numbered; no names, IDs or identities are kept.

| Repository | Read | HTTP | ms | Facts |
| --- | --- | --- | --- | --- |
| 1 | tag refs | 200 | 178 | `{"items":100,"fields":["creator","name","objectId","peeledObjectId","url"],"peeled":99}` |
| 1 | pushes with ref updates | 200 | 61 | `{"items":100,"fields":["date","pushId","pushedBy","refUpdates","repository","url"],"tagUpdateFields":["name","newObjectId","oldObjectId","repositoryId"],"tagUpdates":1,"branchUpdates":32}` |
| 1 | active PRs | 200 | 60 | `{"items":20,"fields":["codeReviewId","createdBy","creationDate","description","isDraft","lastMergeCommit","lastMergeSourceCommit","lastMergeTargetCommit","mergeId","mergeStatus","pullRequestId","repository","reviewers","sourceRefName","status","supportsIterations","targetRefName","title","url"],"reviewerFields":["_links","displayName","hasDeclined","id","imageUrl","isContainer","isFlagged","isRequired","reviewerUrl","uniqueName","url","vote"],"withReviewers":20,"fromForks":0,"timestampFields":["creationDate"]}` |
| 1 | PRs from this repository | 200 | 82 | `{"items":0,"fields":[],"targetOtherRepository":0,"targetOtherProject":0}` |
| 1 | PR threads | 200 | 67 | `{"items":5,"fields":["_links","comments","id","identities","isDeleted","lastUpdatedDate","properties","publishedDate","pullRequestThreadContext","threadContext"],"commentFields":["_links","author","commentType","content","id","lastContentUpdatedDate","lastUpdatedDate","parentCommentId","publishedDate","usersLiked"],"statuses":[],"withThreadType":5,"threadTypes":["IsDraftUpdate","PolicyStatusUpdate","other"]}` |
| 1 | PR policy evaluations | 200 | 98 | `{"items":5,"fields":["artifactId","configuration","evaluationId","startedDate","status"],"statuses":["approved","queued"],"configurationFields":["_links","createdBy","createdDate","id","isBlocking","isDeleted","isEnabled","isEnterpriseManaged","revision","settings","type","url"],"policyTypes":["Build","Comment requirements","Minimum number of reviewers","Required reviewers","other"]}` |
| 1 | PR iterations | 200 | 65 | `{"items":1,"fields":["author","commonRefCommit","createdDate","description","hasMoreCommits","id","reason","sourceRefCommit","targetRefCommit","updatedDate"],"reasons":["push"],"withCommonRefCommit":1,"retargetFields":[]}` |
| 1 | PR merge bases | 200 | 147 | `{"items":1,"fields":["commitId"]}` |
| 1 | creation push commits | 200 | 54 | `{"items":1,"fields":["_links","author","comment","commentTruncated","commitId","committer","remoteUrl","url"],"withParents":0,"outsideParents":0,"tipFirst":true,"newestFirst":null}` |
| 1 | created commit | 200 | 59 | `{"fields":["_links","author","comment","commitId","committer","parents","push","remoteUrl","treeId","url"],"parents":1,"pushFields":["date","pushId","pushedBy"]}` |
| 1 | creation push commits | 200 | 57 | `{"items":1,"fields":["_links","author","comment","commitId","committer","remoteUrl","url"],"withParents":0,"outsideParents":0,"tipFirst":true,"newestFirst":null}` |
| 1 | created commit | 200 | 115 | `{"fields":["_links","author","comment","commitId","committer","parents","push","remoteUrl","treeId","url"],"parents":1,"pushFields":["date","pushId","pushedBy"]}` |
| 1 | creation push commits | 200 | 51 | `{"items":3,"fields":["_links","author","comment","commentTruncated","commitId","committer","remoteUrl","url"],"withParents":0,"outsideParents":0,"tipFirst":false,"newestFirst":false}` |
| 1 | created commit | 200 | 56 | `{"fields":["_links","author","comment","commitId","committer","parents","push","remoteUrl","treeId","url"],"parents":1,"pushFields":["date","pushId","pushedBy"]}` |
