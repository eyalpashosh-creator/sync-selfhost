import type { CSSProperties } from "react";

export function SafeAreaTopScrim({ backgroundColor }: { backgroundColor: string }) {
  const style: CSSProperties = {
    position: "fixed",
    zIndex: 100,
    top: 0,
    left: 0,
    right: 0,
    height: "env(safe-area-inset-top, 0px)",
    backgroundColor,
    pointerEvents: "none",
  };
  return <div aria-hidden="true" style={style} />;
}

export async function fileToBase64(file: Blob): Promise<{ dataBase64: string; mimeType: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const step = 32_768;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + step)));
  }
  return { dataBase64: btoa(binary), mimeType: file.type || "application/octet-stream" };
}
