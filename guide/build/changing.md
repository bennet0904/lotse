# Changing an app

## Describe a change

Under **Describe a change**, write what should be different and choose **Send** (or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>). For example:

- _Make the sign-up button green and larger._
- _Add a page that lists all sign-ups for the studio, protected by a password._
- _The date is shown in US format; use day.month.year._
- _There is an error when I submit the form without an e-mail address._

Each change goes through the same steps as the first build: writing, building and starting, fixing errors, saving. The answer in the conversation lists the changed files under **Changed files**, and the preview updates. One change at a time works best; describe the next one when you have seen the result.

If the project is [linked to a repository](../git/repository), commits made elsewhere are brought in before the change starts.

While a change is being made, the message box is unavailable and says why; you can follow the steps under **Progress** or choose **Stop**.

## Files

The **Files** tab lists the project's files; choose one to read it, with line numbers. Very long files show only their beginning. Editing happens through the conversation (or in the linked repository), so that every change is saved as a version.

## Versions

Every completed change is saved as a version in **Versions**, with its description and time; the newest one is marked **Current**. To go back, choose **Restore** next to an earlier version and confirm. Restoring adds a new version with the old state; later versions stay in the list, so you can go forward again.

The project's history is a normal Git history. If the project is linked to a repository, it is the repository's history.

## Usage

The **Usage** tab lists, per language model, how many requests and tokens this project has used and their estimated cost, with a total in the last row. See [Language models and cost](./models).

## When something goes wrong

- **The app still has errors after the automatic corrections.** Ask it to fix the errors, describe what you see, or restore the last version that worked.
- **The preview does not appear.** See [Troubleshooting](../help/troubleshooting#the-preview-does-not-appear).
- **The result is far from what you wanted.** Be more specific, or restore an earlier version and describe the change again in smaller steps.
