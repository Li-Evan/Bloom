export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}
