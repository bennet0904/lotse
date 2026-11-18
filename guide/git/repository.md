# Keeping code in a repository

A project's code can live in a repository on **GitHub**, **GitLab** (gitlab.com or your own) or **Forgejo / Gitea** (e.g. Codeberg). This is the recommended way to work:

- the code is safe outside Lotse and has a normal Git history,
- you and others can change it with your usual tools,
- the repository can publish the app automatically on every change.

## Connect the platform

On **Providers**, under **Git platforms**, choose **Connect** next to GitHub, GitLab or Forgejo.

- **GitHub:** if your installation has a [GitHub App](../admin/provider-sign-in#github), choose **Continue at GitHub**; you decide on GitHub which repositories Lotse may use. Otherwise create a fine-grained personal access token with the repository permissions Lotse lists.
- **GitLab:** a personal access token with the scope `api`. For your own GitLab, enter its address.
- **Forgejo / Gitea / Codeberg:** an access token with the permissions Lotse lists. For an instance other than Codeberg, enter its address.

## Link a project

In the project, open **Versions**. Under **Repository**:

1. Choose the **Account**.
2. Choose **Create a new repository** (and its name and visibility), or **Use an existing repository** and enter it as `owner/name`.
3. Choose **Link repository**.

The project's history is pushed to the repository. If an existing repository already has commits, they are merged with the project's history; nothing in the repository is overwritten.

## Working together

Once linked:

- **Every completed change is pushed** automatically.
- **Changes made elsewhere are brought in** before the next change starts. If you have a GitHub App, Lotse also notes in the conversation when someone pushes to the repository.
- **Sync now** brings in changes immediately and pushes what Lotse has.
- **Conflicts stop, never overwrite.** If a change in the repository and a change in Lotse touch the same lines, Lotse stops and names the files. Resolve the conflict in the repository (or restore a version in Lotse), then sync again.

## Without a repository

A project works without a repository too: its history is kept in Lotse, and you can link a repository at any time later.
