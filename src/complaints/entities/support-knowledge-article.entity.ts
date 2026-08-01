import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('support_knowledge_articles')
export class SupportKnowledgeArticle {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'text' }) body!: string;
  @Column({ type: 'boolean', default: false }) is_published!: boolean;
  @Column({ type: 'timestamp', nullable: true }) published_at!: Date | null;
  @Column({ type: 'uuid', nullable: true }) created_by!: string | null;
  @Column({ type: 'uuid', nullable: true }) updated_by!: string | null;
  @CreateDateColumn() created_at!: Date;
  @UpdateDateColumn() updated_at!: Date;
  @DeleteDateColumn() deleted_at!: Date | null;
}
