import { useState } from "react";
import { type ApiError, get, post, useLoad } from "../api";
import { useI18n } from "../i18n";
import { Dialog, ErrorNote, timeAgo } from "./common";

interface BackupInfo {
  id: string;
  resource: string;
  createdAt: number;
  bytes: number;
  location: "local" | "s3";
}

function size(bytes: number, locale: string): string {
  if (bytes < 1024 * 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

/** Backups of one database. Restoring replaces the current data, so it needs a confirmation. */
function ResourceBackups({ projectId, resource }: { projectId: string; resource: string }) {
  const { t, locale } = useI18n();
  const list = useLoad(() => get<{ backups: BackupInfo[] }>(`/projects/${projectId}/backups/${resource}`), [projectId, resource]);
  const [restoring, setRestoring] = useState<BackupInfo>();
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <ErrorNote error={error ?? list.error} />
      {done && (
        <p className="note note-ok" role="status">
          {done}
        </p>
      )}
      {list.data && list.data.backups.length === 0 && <p className="hint">{t("backups.none")}</p>}
      {list.data && list.data.backups.length > 0 && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls sideways on narrow screens and must be reachable with the keyboard
        <div className="table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">{t("backups.of", { resource })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("backups.when")}</th>
                <th scope="col" className="num">
                  {t("backups.size")}
                </th>
                <th scope="col">{t("backups.where")}</th>
                <th scope="col">
                  <span className="sr-only">{t("publish.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.backups.map((b) => (
                <tr key={b.id}>
                  <td>
                    <time dateTime={new Date(b.createdAt).toISOString()} title={new Date(b.createdAt).toLocaleString(locale)}>
                      {timeAgo(b.createdAt, locale)}
                    </time>
                  </td>
                  <td className="num">{size(b.bytes, locale)}</td>
                  <td>{b.location === "s3" ? t("backups.s3") : t("backups.local")}</td>
                  <td className="num">
                    <button type="button" className="button-danger button-sm" disabled={busy} onClick={() => setRestoring(b)}>
                      {t("backups.restore")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          className="button-sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await post(`/projects/${projectId}/backups/${resource}`);
              setDone(t("backups.created"));
              list.reload();
            })
          }
        >
          {t("backups.create", { resource })}
        </button>
      </div>
      <Dialog
        open={Boolean(restoring)}
        onClose={() => setRestoring(undefined)}
        title={t("backups.confirmTitle")}
        actions={
          <>
            <button type="button" onClick={() => setRestoring(undefined)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="button-danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const backup = restoring as BackupInfo;
                  setRestoring(undefined);
                  await post(`/projects/${projectId}/backups/${resource}/restore`, { backup: backup.id, approved: true });
                  setDone(t("backups.restored", { when: new Date(backup.createdAt).toLocaleString(locale) }));
                })
              }
            >
              {t("backups.confirm")}
            </button>
          </>
        }
      >
        <p>{t("backups.confirmText", { resource, when: restoring ? new Date(restoring.createdAt).toLocaleString(locale) : "" })}</p>
      </Dialog>
    </div>
  );
}

/** Databases on the app's own server: daily backups, created and restored from here or with `lotse backup`. */
export function Backups({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const info = useLoad(() => get<{ supported: boolean; resources: { name: string; type: string }[] }>(`/projects/${projectId}/backups`), [projectId]);
  if (!info.data?.supported || info.data.resources.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby="backups-heading">
      <div>
        <h3 id="backups-heading">{t("backups.title")}</h3>
        <p className="hint">{t("backups.hint")}</p>
      </div>
      {info.data.resources.map((r) => (
        <section key={r.name} className="stack backups-resource" aria-label={r.name}>
          <h4>
            <code>{r.name}</code> <span className="hint">{r.type}</span>
          </h4>
          <ResourceBackups projectId={projectId} resource={r.name} />
        </section>
      ))}
    </section>
  );
}
