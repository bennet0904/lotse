# What Lotse is

Lotse turns a description of an app into a running app, and publishes it where you choose. It has two parts that also work on their own:

- **The builder** turns a prompt into an app. A language model plans it, writes it in an isolated container, fixes the errors it finds and shows you a live preview. You keep changing it by chatting, and publish it with one click.
- **The hosting core** deploys apps. It knows how to publish to nine hosting providers, three Git platforms and your own servers, and it works for any project, not only for apps the builder wrote.

## Three ways to use it

|                          | For                                   | What you get                                                                                      |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Desktop app](./desktop) | One person on Windows, macOS or Linux | The builder in a window. Projects, accounts and data stay on your computer.                       |
| [Web app](./web-app)     | Teams                                 | The builder on a server, with sign-in, roles (Owner, Admin, Member) and shared provider accounts. |
| [Command line](./cli)    | Developers with an existing project   | The `lotse` command: deploy, roll back, logs, domains, backups, Git sync. No builder.             |

## Words used in this handbook

- **Project**: An app you build with the builder: its conversation, its code with every version, its preview and where it is published.
- **Plan**: What the language model intends to build: technology, pages, data and what the app needs. You approve or change it before anything is built.
- **Sandbox**: A container on your computer or server in which a project's code is installed, run and checked. It sees only its own project and can only reach package registries.
- **Preview**: The running app from the sandbox, shown next to the conversation. It updates while you change the app.
- **Provider**: Where an app is published: a hosting platform such as Vercel, a Git platform's Pages, or your own server. You connect each provider once with an account.
- **Deployment**: One published version of an app. Lotse keeps a history of them so you can return to an earlier one.
- **lotse.yaml**: A small file in every project that describes how the app runs: static files or a server, which port, which database. It is the same for every provider, so you can move an app from one to another.

## What Lotse does not do

- It does not run your apps itself. They run at the provider you choose, under your account and at its prices.
- It sends nothing to the Lotse project: no telemetry, no account, no central service. The only outside services involved are the language model you choose and the providers you connect.
- It never publishes, deletes or changes domains on its own. The language model can only propose such steps; you confirm them.
