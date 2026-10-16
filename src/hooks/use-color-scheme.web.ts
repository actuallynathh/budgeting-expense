import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web.
 *
 * `useSyncExternalStore` gives us the hydration signal without calling setState inside an
 * effect: React renders with the server snapshot (`false`) during SSR and hydration, then
 * re-renders with the client snapshot (`true`) once hydrated. The store never notifies, so
 * the only transition is server -> client, which is exactly what we want.
 */
const subscribe = () => () => {};

export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return 'light';
}
