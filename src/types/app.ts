export interface HttpError {
  message: string;
  status: number;
  success: boolean;
  data?: any;
  stack?: string;
}

export interface HttpResponse<T extends object> {
  data: T;
  message: string;
  status: number;
  success: boolean;
}
