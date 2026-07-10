import { ReviewStatus } from '../entities/review-status.enum';

export interface ReviewAggregates {
  average_rating: number;
  total_reviews: number;
  rating_distribution: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
}

export interface ReviewWithStudent {
  id: string;
  rating: number;
  comment: string | null;
  student: {
    id: string;
    name: string;
  };
  verified_purchase: boolean;
  helpful_count: number;
  /** Present only for lesson reviews that a teacher has replied to. */
  teacher_reply?: string | null;
  teacher_reply_at?: Date | null;
  created_at: Date;
}

/** A review row as seen by a teacher (their lessons) or an admin (moderation). */
export interface ReviewForManagement extends ReviewWithStudent {
  status: ReviewStatus;
  /** Which table the row came from (admin moderation spans both). */
  review_type: 'lesson' | 'teacher';
  /** Target label — lesson title or teacher name — for context in lists. */
  target_id: string;
  target_title: string;
}
