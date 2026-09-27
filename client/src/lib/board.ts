export const DEFAULT_COLORS = ['#111111', '#ffffff', '#ef4444', '#2563eb', '#22c55e', '#facc15', '#8b5cf6'];

export const themeStorageKey = 'syncboard-theme';

export const getBoardCodeFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('board') || '';
};

export const generateShareLink = (code: string) => {
  const base = window.location.origin;
  return `${base}?board=${encodeURIComponent(code)}`;
};

export const formatDeviceName = (value?: string) => {
  if (!value) return 'Your device';
  return value;
};
