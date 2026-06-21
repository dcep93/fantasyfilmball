import shaDetailsRaw from "./sha_x.json?raw";

export type ShaX = {
  time: string;
  git_log: string;
};

export function getShaX(): ShaX {
  return JSON.parse(shaDetailsRaw) as ShaX;
}
