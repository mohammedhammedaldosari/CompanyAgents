/** An error whose message is safe to show to the owner (Arabic), with an HTTP status. */
export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'AppError'; }
}
export const bad = (m: string) => new AppError(m, 400);
export const notFound = (m = 'غير موجود') => new AppError(m, 404);
export const conflict = (m: string) => new AppError(m, 409);
