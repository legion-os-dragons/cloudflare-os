/** Metadata for one caller-scoped, download-only file transfer. */
export interface DownloadRequest {
  /** Single filename of 1–1024 characters, without directory components. */ filename: string;
  /** Original response MIME type, including any parameters. */ mediaType: string;
  /** Exact file length, at most one GiB. */ byteLength: number;
}
/** One sequential chunk; its decoded bytes are bounded to 64 KiB. */
export interface DownloadChunk {
  /** Offset of these bytes in the original file. */ offset: number;
  /** Canonical base64 encoding of this chunk only. */ base64: string;
  /** Lowercase SHA-256 of the decoded chunk. */ sha256: string;
}
/** A real browser download request, not a claim that an OS file was written. */
export interface DownloadReceipt {
  /** The parent accepted and invoked the browser action. */ status: 'available';
  /** Exact requested file and the digest independently computed by the parent. */
  value: {
    /** Browser download was requested. */ action: 'download-requested';
    /** Filename passed to the browser. */ filename: string;
    /** Verified total byte length. */ byteLength: number;
    /** Lowercase SHA-256 of the complete file. */ sha256: string;
  };
}
/** Restricted session that can assemble one file and request its download only. */
export interface DownloadSession {
  /** Append a verified sequential chunk and return the cumulative accepted length. */
  write(chunk: DownloadChunk): Promise<{ received: number }>;
  /** Require the exact declared length, then request the download and release the session. */
  finish(): Promise<DownloadReceipt>;
  /** Release all retained parts without requesting a download. */
  abort(): Promise<void>;
}
