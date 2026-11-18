# Stacks

A stack is the technology an app is built with. The plan names one; the model chooses it from your description, and you can ask for another (_"use Django"_) in the description or with **Change the plan**.

Each stack is a fixed project template: the model fills in the app but does not choose the project's layout, which keeps results predictable and makes every app buildable and runnable without Lotse.

| Stack                    | Runs as      | Best for                                                                         |
| ------------------------ | ------------ | -------------------------------------------------------------------------------- |
| **Static site**          | static files | Landing pages and small tools without a server: plain HTML, CSS and JavaScript.  |
| **React with Vite**      | static files | Interactive single-page apps without their own backend, in React and TypeScript. |
| **Next.js**              | server       | Full-stack React apps with server rendering and API routes in one project.       |
| **Hono API**             | server       | Small, fast HTTP APIs, webhooks and JSON backends in TypeScript.                 |
| **FastAPI** _(beta)_     | server       | Python APIs and data-centric backends, with optional server-rendered pages.      |
| **Django** _(beta)_      | server       | Database-driven Python apps with forms, user accounts and an admin interface.    |
| **Go net/http** _(beta)_ | server       | Small, fast services with few dependencies, using only Go's standard library.    |
| **Laravel** _(beta)_     | container    | Classic database-driven PHP web apps.                                            |

_Beta_ stacks are built and tested, but language models produce working results less reliably with them than with the TypeScript stacks.

## Where each kind can be published

- **Static files** can go almost anywhere: every hosting provider, your own server, and GitHub, GitLab or Codeberg Pages.
- **Servers** need a provider that runs code in their language. Node.js runs nearly everywhere; Python, Go and PHP need a provider that runs containers (your own server, Hetzner Cloud, Coolify, Dokploy, Railway, Fly.io).
- **Containers** need a provider that runs containers.

When you publish, Lotse checks this before anything happens and suggests providers that fit. See [Choosing a provider](../providers/overview).
