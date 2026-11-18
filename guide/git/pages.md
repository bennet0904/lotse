# Pages hosting

GitHub Pages, GitLab Pages and Codeberg Pages serve static websites for free from a repository. Lotse can publish apps that consist of static files there: the _Static site_ and _React with Vite_ stacks, or any project with static output.

## Connect

On **Providers**, under **Hosting**, connect **GitHub Pages**, **GitLab Pages** or **Codeberg Pages** with an account of the platform (the same sign-in as for the Git platform).

## Publish

Choose the Pages account under **Publish to** and publish as usual. Lotse

1. uses the repository named after the app, or creates it (public) if it does not exist,
2. puts the built site on a separate branch (`gh-pages` on GitHub, `pages` on GitLab and Codeberg) as a new commit; the code on the main branch is not touched,
3. turns on Pages for the repository where needed.

| Platform       | Address                              |
| -------------- | ------------------------------------ |
| GitHub Pages   | `https://<user>.github.io/<app>`     |
| GitLab Pages   | `https://<group>.gitlab.io/<app>`    |
| Codeberg Pages | `https://<user>.codeberg.page/<app>` |

It can take a minute or two after publishing until the platform serves the new version.

## Limits

- Only static files: no server, no database, no secrets at runtime.
- No rollback: to go back, restore an earlier version in **Versions** and publish again.
- Custom domains: Lotse can add them on GitHub Pages; on GitLab and Codeberg, set them in the repository's Pages settings.

## Taking it offline

Removing the published app turns off Pages (GitHub, GitLab) or deletes the `pages` branch (Codeberg). The repository itself is kept.
