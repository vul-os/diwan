// mammoth ships no type declarations and none exist on DefinitelyTyped either.
// This is a minimal shim covering exactly the surface importFile.ts uses
// (convertToHtml + the images.imgElement custom-image-converter hook) — not a
// full re-statement of mammoth's API.
declare module 'mammoth' {
  export type MammothImage = {
    contentType: string
    readAsBase64String(): Promise<string>
    readAsArrayBuffer(): Promise<ArrayBuffer>
  }

  export type MammothImageResult = { src: string; [key: string]: unknown }

  export const images: {
    imgElement(
      handler: (image: MammothImage) => Promise<MammothImageResult>
    ): unknown
  }

  export type ConvertToHtmlOptions = {
    convertImage?: unknown
    [key: string]: unknown
  }

  export type ConvertToHtmlInput = { arrayBuffer: ArrayBuffer } | { buffer: Buffer } | { path: string }

  export type ConvertToHtmlResult = {
    value: string
    messages: Array<{ type: string; message: string }>
  }

  export function convertToHtml(
    input: ConvertToHtmlInput,
    options?: ConvertToHtmlOptions
  ): Promise<ConvertToHtmlResult>

  const mammoth: {
    images: typeof images
    convertToHtml: typeof convertToHtml
  }
  export default mammoth
}
