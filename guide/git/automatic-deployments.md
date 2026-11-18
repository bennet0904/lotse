# Automatic deployments

With automatic deployments, the repository publishes the app itself whenever its main branch changes, whether the change came from Lotse or from someone editing the code directly. This works for every hosting provider, including those without their own Git integration, such as your own server.

## Set up

Requirements: the project is [linked to a repository](./repository) and has been [published](../publish/publishing) once.

In the project, open **Versions** and, under **Automatic deployments**, choose **Set up automatic deployments**. Optionally check **Also publish a preview for every pull or merge request**.

Lotse then

1. writes a pipeline into the repository:
   - GitHub: `.github/workflows/lotse-deploy.yml`
   - Forgejo / Codeberg: `.forgejo/workflows/lotse-deploy.yml`
   - GitLab: `.gitlab-ci.yml`
2. stores what the pipeline needs as encrypted CI secrets of the repository: the account of the hosting provider (`LOTSE_CONNECTION_<PROVIDER>`) and the app's secrets and database addresses (`LOTSE_VAULT`).

The pipeline runs the Lotse command-line tool, which builds and publishes the app exactly as the builder does. Setting it up again updates the pipeline and the secrets.

::: warning
On GitLab, the pipeline is the repository's `.gitlab-ci.yml`. If the repository already has one, it is replaced; Lotse's change is a normal commit you can revert.

Anyone who can change the pipelines of the repository can use the stored provider account. Keep the repository's write access to people you would also give the account to.
:::

## Previews of pull and merge requests

With previews enabled, every pull request (GitHub, Forgejo) or merge request (GitLab) is published as a separate preview deployment, and its address is posted as a comment on the request. This works with providers that support preview deployments (Vercel, Netlify).

## With the command line

In a project folder that is linked with `lotse git link`:

```sh
lotse git ci --target vercel            # add --previews for pull request previews
```
