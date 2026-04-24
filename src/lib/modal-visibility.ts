import * as React from "react";

export const MODAL_EXIT_ANIMATION_MS = 200;

let activeModalCount = 0;
let modalBrowserHidden = false;
let restoreTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

const setModalBrowserHidden = (nextValue: boolean) => {
  if (modalBrowserHidden === nextValue) {
    return;
  }

  modalBrowserHidden = nextValue;
  emit();
};

const cancelRestoreTimer = () => {
  if (restoreTimer === null) {
    return;
  }

  globalThis.clearTimeout(restoreTimer);
  restoreTimer = null;
};

const markModalOpened = () => {
  cancelRestoreTimer();
  activeModalCount += 1;
  setModalBrowserHidden(true);
};

const markModalClosed = () => {
  if (activeModalCount === 0) {
    return;
  }

  activeModalCount -= 1;

  if (activeModalCount > 0) {
    return;
  }

  cancelRestoreTimer();
  restoreTimer = globalThis.setTimeout(() => {
    restoreTimer = null;

    if (activeModalCount === 0) {
      setModalBrowserHidden(false);
    }
  }, MODAL_EXIT_ANIMATION_MS);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export const isModalBrowserHidden = () => modalBrowserHidden;

export const useModalBrowserHidden = () =>
  React.useSyncExternalStore(
    subscribe,
    () => modalBrowserHidden,
    () => false,
  );

export const useRegisterModalVisibility = (open: boolean) => {
  const isRegisteredRef = React.useRef(false);

  React.useEffect(() => {
    if (open && !isRegisteredRef.current) {
      isRegisteredRef.current = true;
      markModalOpened();
      return;
    }

    if (!open && isRegisteredRef.current) {
      isRegisteredRef.current = false;
      markModalClosed();
    }
  }, [open]);

  React.useEffect(() => {
    return () => {
      if (!isRegisteredRef.current) {
        return;
      }

      isRegisteredRef.current = false;
      markModalClosed();
    };
  }, []);
};
