const { Octokit } = require('@octokit/rest');

function getOctokit(accessToken) {
  return new Octokit({ auth: accessToken });
}

async function listRepos(accessToken) {
  const octokit = getOctokit(accessToken);
  const { data } = await octokit.repos.listForAuthenticatedUser({
    sort: 'updated',
    per_page: 50,
    type: 'all',
  });
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    url: r.html_url,
    defaultBranch: r.default_branch,
    description: r.description,
  }));
}

async function getUser(accessToken) {
  const octokit = getOctokit(accessToken);
  const { data } = await octokit.users.getAuthenticated();
  return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
}

/**
 * Create a new public repository for the authenticated user.
 * If the name is taken, appends a numeric suffix until it finds a free name.
 */
async function createRepo(accessToken, name, description = 'Created with AppBuilder') {
  const octokit = getOctokit(accessToken);
  let repoName = name;
  let attempt  = 0;

  while (true) {
    try {
      const { data } = await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        description,
        private: false,
        auto_init: true,   // creates an initial commit so main branch always exists
      });
      return { name: data.name, owner: data.owner.login, url: data.html_url };
    } catch (err) {
      if (err.status === 422 && attempt < 5) {
        // Name taken — try adding a suffix
        attempt++;
        repoName = `${name}-${attempt}`;
      } else {
        throw err;
      }
    }
  }
}

/**
 * Push a set of files to the repo's target branch (default: 'main').
 * Pass the repo's defaultBranch so edits go to the right branch.
 * files: [{ path: 'index.html', content: '...' }, ...]
 */
async function pushFiles(accessToken, owner, repo, files, commitMessage = 'Add app files via AppBuilder', branch = 'main') {
  const octokit = getOctokit(accessToken);

  // Get the current HEAD commit SHA
  let latestSha;
  let treeSha;
  try {
    const { data: ref } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    latestSha = ref.object.sha;
    const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: latestSha });
    treeSha = commit.tree.sha;
  } catch (err) {
    // Repo is empty — we'll create a root commit with no base tree
    treeSha = null;
    latestSha = null;
  }

  // Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async (file) => {
      const { data: blob } = await octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64',
      });
      return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
    })
  );

  // Create new tree (omit base_tree for empty repos to avoid API errors)
  const treePayload = { owner, repo, tree: treeItems };
  if (treeSha) treePayload.base_tree = treeSha;
  const { data: newTree } = await octokit.git.createTree(treePayload);

  // Create commit
  const parents = latestSha ? [latestSha] : [];
  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents,
  });

  // Update target branch ref
  try {
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
      force: false,
    });
  } catch {
    // Branch didn't exist yet — create it
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: newCommit.sha,
    });
  }

  return `https://github.com/${owner}/${repo}`;
}

/**
 * Enable GitHub Pages on the repo's target branch.
 * Silently accepts "already enabled" responses — Octokit v21 can put the HTTP
 * status on either err.status or err.response?.status depending on the error
 * type, so we check both.  GitHub also occasionally returns 409 instead of
 * 422 for this condition, so we accept both.
 */
async function enablePages(accessToken, owner, repo, branch = 'main') {
  const octokit = getOctokit(accessToken);
  try {
    await octokit.repos.createPagesSite({
      owner,
      repo,
      source: { branch, path: '/' },
    });
  } catch (err) {
    const status = err.status ?? err.response?.status;
    // 422 = validation failed (pages already enabled)
    // 409 = conflict (pages already enabled on some API versions)
    if (status !== 422 && status !== 409) throw err;
  }
  return `https://${owner}.github.io/${repo}`;
}

/**
 * Fetch a single file's content from a repo.
 * Returns the decoded UTF-8 string, or null if the file doesn't exist.
 */
async function getFileContent(accessToken, owner, repo, path = 'index.html') {
  const octokit = getOctokit(accessToken);
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    if (Array.isArray(data)) throw new Error('Path is a directory, not a file');
    if (!data.content) return null;
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

module.exports = { listRepos, getUser, createRepo, pushFiles, enablePages, getFileContent };
