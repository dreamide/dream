import { useCallback, useRef, useState } from "react";

/**
 * Manages state that can be either controlled or uncontrolled.
 * Drop-in replacement for @radix-ui/react-use-controllable-state.
 */
export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: T;
  defaultProp?: T;
  onChange?: (value: T) => void;
}): [T, (next: T | ((prev: T) => T)) => void] {
  const [internal, setInternal] = useState<T>(defaultProp as T);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : internal;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const nextValue =
        typeof next === "function" ? (next as (prev: T) => T)(value) : next;

      if (!isControlled) {
        setInternal(nextValue);
      }

      onChangeRef.current?.(nextValue);
    },
    [isControlled, value],
  );

  return [value, setValue];
}
