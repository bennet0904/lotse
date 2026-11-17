import { type MouseEvent, type ReactNode, useEffect, useState } from "react";

/** A very small router on the History API; the app has four screens. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const update = () => setPath(location.pathname + location.search);
    addEventListener("popstate", update);
    addEventListener("lotse:navigate", update);
    return () => {
      removeEventListener("popstate", update);
      removeEventListener("lotse:navigate", update);
    };
  }, []);
  return path;
}

export function navigate(to: string): void {
  history.pushState(null, "", to);
  dispatchEvent(new Event("lotse:navigate"));
}

export function Link({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className} aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}
