# Updates and backups

## Updating

New versions are listed on the [releases page](https://github.com/bennet0904/lotse/releases).

**Web app:**

```sh
cd lotse/deploy
docker compose pull
docker compose up -d
```

Database changes are applied automatically when Lotse starts. Running jobs are interrupted by the restart; start them again afterwards. To stay on a version, set `LOTSE_IMAGE=ghcr.io/bennet0904/lotse:<version>` in `.env`.

Releases are signed. To check an image before you run it, use [cosign](https://docs.sigstore.dev/cosign/system_config/installation/):

```sh
cosign verify ghcr.io/bennet0904/lotse:<version> \
  --certificate-identity-regexp 'https://github.com/bennet0904/lotse/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Desktop app:** download and install the new version over the old one. Your data stays.

**Command line:** `npm install -g @lotseai/cli@latest`.

## Backing up Lotse itself

| What            | Where                                            | Why                                                        |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| The database    | The `db` volume of the compose file (PostgreSQL) | Projects, people, conversations, encrypted credentials     |
| The data folder | `/srv/lotse`                                     | Every project's code and history                           |
| The master key  | `LOTSE_MASTER_KEY` in `.env`, or your Vault      | Without it, the credentials in the database cannot be read |

For example, a nightly database dump:

```sh
docker compose exec -T db pg_dump -U lotse lotse | gzip > lotse-$(date +%F).sql.gz
```

Projects linked to a repository also have their code there.

To restore: start a fresh installation with the same `.env`, load the dump into the `db` container (`gunzip -c … | docker compose exec -T db psql -U lotse lotse`), and copy back the data folder.

Your apps' own databases are backed up separately: by your own server (see [Databases and backups](../publish/databases)) or by their providers.

## The desktop app

Its data folder ([where](../start/desktop#where-your-data-is)) contains everything; copy it to back up. The key that unlocks the stored accounts stays in the computer's keychain, so after moving to a new computer, connect the accounts again.
