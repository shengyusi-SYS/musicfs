import { useEffect, useState } from 'react';

export type WorkspacePage = 'sources' | 'library' | 'connection' | 'plugins';
const pages = new Set<WorkspacePage>(['sources', 'library', 'connection', 'plugins']);
function currentPage(): WorkspacePage {
  const value = new URLSearchParams(location.search).get('page') as WorkspacePage;
  return pages.has(value) ? value : 'sources';
}

export function useWorkspaceNavigation() {
  const [page, setPage] = useState(currentPage);
  useEffect(() => {
    const back = () => setPage(currentPage());
    addEventListener('popstate', back);
    return () => removeEventListener('popstate', back);
  }, []);
  function navigate(next: WorkspacePage) {
    if (next === page) return;
    const url = new URL(location.href);
    url.searchParams.set('page', next);
    history.pushState(null, '', url);
    setPage(next);
  }
  return { page, navigate };
}
