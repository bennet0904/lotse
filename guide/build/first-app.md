# Your first app

This page walks through building an app from a description to a running preview. It works the same in the desktop app and the web app.

**Before you start:** a [container runtime](../start/desktop#a-container-runtime) must be running, and a [language model](./models) must be set up. If either is missing, the start page tells you.

## 1. Describe the app

On **Apps**, write what the app should do under **Describe your app**. Describe it as you would to a person who builds it for you:

- **What it is for and who uses it:** _A booking page for a small yoga studio._
- **What people see and do:** _A weekly schedule; visitors pick a class and sign up with their name and e-mail._
- **What it should keep:** _Sign-ups are stored, and the studio sees a list per class._
- **Anything that matters to you:** a language, colors, _"use Python"_, _"no login"_.

You do not need to name a technology. Under **Options** you can choose a different [language model](./models) for this app. Choose **Plan the app**.

Below the description, **Your apps** lists every app with its status and when it last changed. Apps that failed or that are being planned or built are marked at the left edge, so you can spot them quickly.

## 2. Review the plan

After a few seconds the conversation shows the **Plan**:

| Part       | Meaning                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Title      | The app's name                                                                                  |
| Technology | The [stack](./stacks) it will be built with. _beta_ marks stacks that are less reliable so far. |
| Pages      | The screens or endpoints, and what each is for                                                  |
| Data       | What the app stores                                                                             |
| Needs      | Services the app needs to run, e.g. a Postgres database                                         |

Nothing has been built yet. You can adjust the title and the technology directly in the plan. If something else is wrong, choose **Change the plan**, write what should be different (_"Use a database instead of storing in the browser"_, _"Also show a list of past classes"_) and choose **Revise plan**. When it fits, choose **Build it**.

## 3. Watch it being built

**Progress** shows what happens, one step per line: a check mark for finished steps, a spinner and the current activity for the running one, and a cross for a step that failed. **Show all details** opens the full log. The steps are:

1. **Writing the app** — the model creates and edits files. It works inside your project's sandbox and can run commands there, e.g. to install packages.
2. **Building and starting the app** — Lotse installs dependencies, runs the stack's checks (such as the TypeScript compiler) and starts the app.
3. **Fixing errors** — if the checks fail or the app does not start, the errors go back to the model, which corrects them. This repeats up to three times.
4. **Saving the version** — the result is saved as a version you can return to.

You can choose **Stop** at any time; nothing is lost. While it works, the message box below the conversation waits; it says why.

When it is done, the model summarizes what it built. If errors remain after the corrections, the conversation says so: describe what is wrong, or simply ask it to fix the errors. If the build fails, the conversation explains what went wrong and what you can do next.

## 4. Try the preview

The **Preview** tab shows the running app. It is a real server in the sandbox, not a picture: you can click through it, fill in forms and see the results. **Open in new tab** shows it in its own browser tab; **Reload** reloads it. While the first version is still being built, the tab says so and the preview appears by itself once the app runs.

Previews stay running while you work. After 30 minutes without use, the sandbox pauses to save resources and resumes the next time you open the project.

## What the model can and cannot do

- It works only inside the project's sandbox. The sandbox sees only this project and can only reach package registries (npm, PyPI, the Go proxy, Packagist).
- It never sees your provider accounts, keys or secrets.
- It cannot publish, delete an app, set up a server or change domains. It can **propose** such a step — the proposal appears in the conversation — and you carry it out yourself.
- Text in files, packages or web pages is treated as data, never as instructions to Lotse.

## Next

- Keep improving it: [Changing an app](./changing).
- Put it online: [Publishing an app](../publish/publishing).
