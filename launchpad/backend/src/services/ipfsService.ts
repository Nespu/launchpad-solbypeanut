import { config } from "../utils/config";
import { logger } from "../utils/logger";

/**
 * Uploads a base64-encoded image to IPFS via Pinata and returns the gateway URL.
 * imageBase64 should be a data URL (e.g. "data:image/png;base64,....") or raw base64.
 */
export async function uploadImageToIpfs(imageBase64: string, filename = "token.png"): Promise<string> {
  const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
  const buffer = Buffer.from(base64Data, "base64");

  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.pinataJwt}` },
    body: form as any,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, text }, "Pinata image upload failed");
    throw new Error("Failed to upload image to IPFS");
  }

  const data = (await res.json()) as { IpfsHash: string };
  return `https://${config.pinataGateway}/ipfs/${data.IpfsHash}`;
}

/** Uploads the Metaplex-standard JSON metadata object and returns its IPFS URL. */
export async function uploadMetadataToIpfs(metadata: {
  name: string;
  symbol: string;
  description: string;
  image: string;
}): Promise<string> {
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.pinataJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pinataContent: metadata }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, text }, "Pinata metadata upload failed");
    throw new Error("Failed to upload metadata to IPFS");
  }

  const data = (await res.json()) as { IpfsHash: string };
  return `https://${config.pinataGateway}/ipfs/${data.IpfsHash}`;
}
