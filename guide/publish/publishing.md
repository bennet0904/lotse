# Publishing an app

Publishing puts an app online at one of your [connected providers](../providers/connecting). In a project, open the **Publish** tab.

## Publish

1. Under **Publish to**, choose the account. If there is none, choose **Connect a provider**.
2. Choose **Check what will happen**. Lotse plans the deployment without changing anything and shows:
   - whether it is the **First deployment** to this provider or an **Update**,
   - the steps it will take, e.g. _Create project_, _Create database "db"_, _Deploy_,
   - warnings, e.g. when the provider cannot run something the app needs, with providers that can,
   - a field for every [secret](./secrets) the app needs that has no value yet.
3. Choose **Publish**. The first time an app goes to a provider, Lotse asks once more — **Publish for the first time?** — because this creates something publicly reachable that the provider may charge for. Confirm with **Yes, publish**.

**Progress** shows what happens:

| Step                                  | What happens                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Building                              | The app is built: static files, or a container image for server apps.                |
| Preparing resources                   | Databases are created at the first deployment and their addresses passed to the app. |
| Deploying                             | The build is uploaded and the new version started at the provider.                   |
| Checking that the new version answers | Lotse calls the app until it answers.                                                |
| Finished                              | **Your app is live** with its address.                                               |

If the new version does not answer, Lotse puts the previous version back (**Restoring the previous version**) where the provider supports it. A failed or stopped deployment never takes down the version that was running before.

## Publishing changes

After you change the app, choose **Check what will happen** and **Publish** again. Updates need no extra confirmation. To publish automatically on every change, link a repository and set up [automatic deployments](../git/automatic-deployments).

## The published app

Below the publish form, **Published app** shows:

- **Status** and the app's address.
- **Deployments**: every published version with its state and time. **Roll back to this** returns to an earlier version. On providers without rollback (Dokploy, Pages), publish the earlier version instead: restore it under **Versions** and publish again.
- **Custom domain**: see [Custom domains](./domains).
- **Logs**: the app's latest log lines from the provider. Static hosts have no logs.
- **Secrets**: see [Secrets and settings](./secrets).
- **Database backups**: for apps on your own server, see [Databases and backups](./databases).

## Taking an app offline

Under **Remove the published app**, choose **Remove published app…** and confirm. The app is removed at the provider and is no longer reachable. The project, its code and its versions stay in Lotse, so you can publish it again later.

Databases at an external provider (Neon, Supabase) are kept, so that no data is lost by accident; delete them at the provider if you no longer need them. On your own server, see [what is removed](../providers/own-server#removing-apps-from-the-server).

## Moving to another provider

Choose another account under **Publish to** and publish. The first deployment there needs the confirmation again. The app at the old provider keeps running until you remove it. Data in databases does not move by itself.
