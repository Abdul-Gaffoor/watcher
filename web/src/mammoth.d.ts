/**
 * Mammoth ships no types for its browser bundle. Only the one call is used, so
 * the shape is declared here rather than pulling in a types package for it.
 */
declare module 'mammoth/mammoth.browser' {
  interface ConvertResult {
    value: string;
    messages: { type: string; message: string }[];
  }
  const mammoth: {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
  };
  export default mammoth;
}
