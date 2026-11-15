/**
 * PDF.js validates directory strings as URLs, but its Node factory reads them
 * with fs.readFile. Forward-slash filesystem paths satisfy both APIs on Windows
 * and POSIX; a file:// string would instead be treated as a literal filename.
 */
export function pdfResourceDirectories(packageRoot: string) {
  const root = packageRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  return {
    cMapUrl: `${root}/cmaps/`,
    standardFontDataUrl: `${root}/standard_fonts/`,
    wasmUrl: `${root}/wasm/`,
  };
}
