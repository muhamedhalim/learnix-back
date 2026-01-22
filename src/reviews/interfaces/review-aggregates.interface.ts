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
  created_at: Date;
}
