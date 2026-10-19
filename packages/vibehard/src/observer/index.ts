/** Stage 2: coverage observation + range→symbol mapping. */
export interface ObservedRange {
  file: string;
  startOffset: number;
  endOffset: number;
}

export function collectObservedRanges(): Promise<ObservedRange[]> {
  return Promise.reject(new Error("observer: not implemented (Stage 2)"));
}
