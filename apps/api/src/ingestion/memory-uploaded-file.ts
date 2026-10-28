/**
 * The shape of `req.file` under multer's memoryStorage, limited to the
 * fields this codebase actually reads. Defined locally instead of relying
 * on @types/multer's `Express.Multer.File` global augmentation, which this
 * project deliberately doesn't depend on (see multer.d.ts).
 */
export interface MemoryUploadedFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}
