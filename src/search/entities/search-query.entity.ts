import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A logged search query. Powers "recent" (per user) and "popular" (global,
 * aggregated) search suggestions. Stored lower-cased/trimmed by the service.
 */
@Entity('search_queries')
@Index('idx_search_queries_query', ['query'])
@Index('idx_search_queries_user_created', ['user_id', 'created_at'])
export class SearchQueryLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  query!: string;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  user_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
