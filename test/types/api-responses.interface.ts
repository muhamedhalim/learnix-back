import type { PaymentStatus } from '../../src/payments/enums/payment-status.enum';
import type { FileType } from '../../src/resources/enums/file-type.enum';
import type { ResourceType } from '../../src/resources/enums/resource-type.enum';

export interface ChapterResponse {
  id: number;
  title: string;
  description: string | null;
  order_index: number;
  course_id: number;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at?: string | Date | null;
  lessons?: LessonResponse[];
  resources?: ResourceResponse[];
  lessonCount?: number;
}

export interface LessonResponse {
  id: number;
  title: string;
  content: string | null;
  vimeo_url: string | null;
  order_index: number;
  chapter_id: number;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at?: string | Date | null;
  resources?: ResourceResponse[];
}

export interface ResourceResponse {
  id: number;
  title: string;
  description: string | null;
  filename: string;
  original_name: string;
  file_path: string;
  file_size: number | string;
  mime_type: string;
  resource_type: ResourceType;
  file_type: FileType;
  chapter_id: number | null;
  lesson_id: number | null;
  uploaded_by: number | null;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at?: string | Date | null;
  file_url?: string;
}

export interface CourseResponse {
  id: number;
  title: string;
  description: string;
  difficulty: string[];
  price: number | string;
  thumbnail_url?: string | null;
  is_published: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at?: string | Date | null;
  chapters?: ChapterResponse[];
  enrollmentCount?: number;
}

export interface CourseHierarchyResponse {
  id: number;
  title: string;
  description: string;
  difficulty: string[];
  price: number | string;
  thumbnail_url?: string | null;
  is_published: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  chapters: ChapterResponse[];
}

export interface UserResponse {
  id: number;
  email: string;
  username: string;
  full_name?: string | null;
  role: string;
  xp: number;
  rank: string;
  total_submissions: number;
  successful_submissions: number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PaymentResponse {
  id: number;
  user_id: number;
  course_id?: number;
  amount: number;
  currency: string;
  payment_status: PaymentStatus;
  payment_method: string;
  paymob_transaction_id?: string | null;
  order_id?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AuthResponse {
  access_token: string;
  user?: UserResponse;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
