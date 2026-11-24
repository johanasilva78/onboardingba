const maxDimension = 1800;
const maxEncodedLength = 420_000;

export async function preparePhoto(file: File) {
  if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 16 * 1024 * 1024) {
    throw new Error("Elige una imagen JPG o PNG de hasta 16 MB.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("No pudimos abrir la imagen. Prueba con otra foto."));
      image.src = objectUrl;
    });

    if (Math.min(image.width, image.height) < 200) {
      throw new Error("La foto es demasiado pequeña. Toma una foto más nítida del documento.");
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Tu navegador no pudo preparar la imagen.");
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    for (const reduction of [1, 0.8, 0.65]) {
      canvas.width = Math.round(image.width * scale * reduction);
      canvas.height = Math.round(image.height * scale * reduction);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const encoded = canvas.toDataURL("image/jpeg", 0.84).split(",")[1];
      if (encoded && encoded.length <= maxEncodedLength) return encoded;
    }
    throw new Error("No pudimos preparar esa foto. Acerca el documento y vuelve a tomarla.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
