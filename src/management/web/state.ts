let dirtyGuard: (() => boolean) | undefined;

export function setDirtyGuard(guard?: () => boolean) {
  dirtyGuard = guard;
}

export function hasUnsavedChanges() {
  return dirtyGuard?.() ?? false;
}

export function installBeforeUnload() {
  window.addEventListener('beforeunload', event => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
