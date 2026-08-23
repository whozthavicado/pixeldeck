import AdmZip from "adm-zip";

/** Empaqueta una lista de archivos (rutas absolutas) en un .zip en `outputPath`, con el nombre dado a cada uno dentro del archivo. */
export async function buildZip(files: Array<{ path: string; nameInZip: string }>, outputPath: string): Promise<void> {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addLocalFile(file.path, "", file.nameInZip);
  }
  await zip.writeZipPromise(outputPath);
}
