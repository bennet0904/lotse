# Your own server

Lotse can turn a fresh server into a hosting platform for your apps: it sets it up after your approval, deploys without downtime, runs databases next to your apps and backs them up every day.

## What you need

- A server with **Ubuntu 24.04** (or later) or **Debian 12** (or later), with a public IP address. A small virtual server with 2 GB memory is enough for several small apps.
- SSH access as `root`, or as a user that may use `sudo` without a password.
- Ports 22, 80 and 443 reachable from the internet.

Other Linux distributions work if Docker is already installed; Lotse then skips the setup steps it cannot do there.

If you have a Hetzner Cloud account, Lotse can also create the server for you: connect **Hetzner Cloud** instead and continue with _Set up the server_ below.

## 1. Connect the server

On **Providers**, choose **Connect** next to **Own server (SSH)**:

1. Enter the **Server address**, the **User** (usually `root`) and, if different from 22, the **Port**.
2. Choose **Generate SSH key**. Lotse creates a key pair for this server; the private key never leaves Lotse.
3. Either add the shown **Public key** as a line to `~/.ssh/authorized_keys` of that user on the server, or enter the user's **Password (used once)**: Lotse then installs the key itself and forgets the password.
4. Optionally enter a **Domain for apps** (see [addresses](#addresses-of-your-apps)) and [backup storage](#backups).
5. Choose **Connect**.

On the first connection Lotse remembers the server's identity (host key). If it ever changes, Lotse refuses to connect, because someone could be impersonating your server.

## 2. Set up the server

Choose **Set up server** next to the connected account. Lotse inspects the server and lists every change it would make, each marked _to do_, _done_ or _skipped_:

1. **Create the deployment user `lotse`**, which Lotse uses from then on, with your key.
2. **Install Docker Engine**, which runs your apps and databases.
3. **Start Caddy** as the web server in front of your apps. It obtains HTTPS certificates for your domains automatically.
4. **Configure the firewall:** only SSH (22), HTTP (80) and HTTPS (443) stay open.
5. **Enable automatic security updates** of the operating system.
6. **Schedule daily database backups.**

Read the list, check **I have read the changes above and approve them**, and choose **Set up the server**. Nothing is changed before you approve. Setup takes a few minutes; you can follow it step by step. You can run it again at any time; steps that are already done are skipped.

## Addresses of your apps

- **Without a domain**, an app gets an address like `http://guest-book.203-0-113-10.sslip.io`. It works immediately, because sslip.io turns the server's IP address into a name. Use it for testing.
- **With a domain for apps**, e.g. `apps.example.com`, create one DNS record `*.apps.example.com` → your server's IP address. Each app then gets `https://<app>.apps.example.com` with a certificate. With the command line: `lotse connect ssh --host … --option baseDomain=apps.example.com`.
- **Custom domains** for single apps work as on every provider: see [Custom domains](../publish/domains).

## How deployments work on your server

- Lotse builds the app (on your computer or the builder's server, not on the target server) and transfers it over SSH.
- The new version starts next to the old one. Caddy switches traffic to it only after its health check succeeds, so there is no downtime. If the new version does not become healthy, the old one keeps running untouched.
- The last three versions stay on the server, so a rollback is instant.
- Several apps run side by side on one server; Caddy routes requests by domain.

## Databases

If an app needs Postgres or Redis, Lotse runs it as a container next to the app, with its data on a persistent volume, and passes its address to the app (e.g. as `DATABASE_URL`). Databases are reachable only from your apps, not from the internet.

## Backups

Every night, the server backs up every Postgres and Redis database of every app. The last 14 backups are kept on the server.

To also keep them outside the server, open **Also keep backups in object storage (S3)** when connecting the server and enter a bucket of AWS S3 or any S3-compatible storage (Hetzner Object Storage, Cloudflare R2, MinIO, …) with an access key that may write to it. On the command line:

```sh
lotse connect ssh --host 203.0.113.10 \
  --option s3Bucket=my-backups --option s3Endpoint=https://fsn1.your-objectstorage.com \
  --secret s3AccessKey=… --secret s3SecretKey=…
```

The settings take effect when an app's database is next created or backed up. Creating, listing and restoring backups is described in [Databases and backups](../publish/databases#backups-on-your-own-server).

## Removing apps from the server

Removing a published app (see [Publishing](../publish/publishing#taking-an-app-offline)) stops it and deletes its containers, images, files and its databases' data. Its backups stay on the server in `/opt/lotse/backups/<app>/`, so you can still restore the data elsewhere; delete them by hand when you no longer need them.
