// Type definitions for the FoldPass browser SDK (foldpass.esm.js).

export const version: string;
/** Origin of the FoldPass server the SDK was loaded from. */
export const host: string;

export class FoldPassError extends Error {
  /** e.g. BAD_SITE_KEY, BAD_ORIGIN, BAD_CONTAINER, NETWORK, HTTP_429 */
  code: string;
}

export interface SolvedUnit {
  id: string;
  benchmarkId: string;
  sequence: string;
  fold: string;
  contacts: number;
  status: 'open' | 'disputed' | 'validated';
  replicas?: number;
  needed?: number;
  ms: number;
}

export interface Progress {
  phase: 'pow' | 'fold' | 'submit';
  /** 0..1 within the phase */
  fraction: number;
  /** 0..1 across the whole solve */
  overall: number;
  bestFold?: string;
  bestContacts?: number;
  unit: { id: string; benchmarkId: string; sequence: string; attempts: number };
}

export interface SolveOptions {
  siteKey: string;
  onProgress?: (p: Progress) => void;
}

export function solve(options: SolveOptions): Promise<{ token: string; expiresIn: number; unit: SolvedUnit }>;
export function execute(options: SolveOptions | string): Promise<string>;

export interface RenderOptions {
  siteKey: string;
  /** 'light' (default) or 'dark'. */
  theme?: 'dark' | 'light';
  /** 'classify' shows a real Zooniverse research question instead of folding. */
  task?: 'fold' | 'classify';
  /** Name of the hidden input added to the enclosing form. Default "fold-captcha-token". */
  inputName?: string;
  onSuccess?: (token: string, unit: SolvedUnit) => void;
  onError?: (err: FoldPassError) => void;
  onExpired?: () => void;
}

export interface FoldCaptchaWidget extends HTMLElement {
  readonly token: string | null;
  execute(): Promise<string>;
  reset(): void;
}

export function render(container: string | Element, options: RenderOptions): FoldCaptchaWidget;
export function autoRender(root?: ParentNode): FoldCaptchaWidget[];

export interface VolunteerOptions {
  threads?: number;
  pauseOnBattery?: boolean;
  pauseWhenHidden?: boolean;
  onResult?: (r: { unitId: string; benchmarkId: string; contacts: number; status: string; ms: number }) => void;
  onStatus?: (s: { running: boolean; paused: boolean; threads: number; units: number; conformations: number; validated: number; errors: number }) => void;
}

export interface VolunteerController {
  readonly running: boolean;
  readonly paused: boolean;
  readonly stats: { units: number; conformations: number; validated: number; errors: number };
  start(): void;
  stop(): void;
}

export function volunteer(options?: VolunteerOptions): VolunteerController;

declare const FoldPass: {
  version: string;
  host: string;
  render: typeof render;
  execute: typeof execute;
  solve: typeof solve;
  autoRender: typeof autoRender;
  volunteer: typeof volunteer;
  FoldPassError: typeof FoldPassError;
};
export default FoldPass;
