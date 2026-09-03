import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** FR-034 – FR-040. A two-level taxonomy, entirely separate from academic `subjects`. */
@Entity('marketplace_categories')
@Index('IDX_mp_categories_parent_order', ['parent_id', 'display_order'])
@Index('UQ_mp_categories_slug', ['slug'], { unique: true })
export class MarketplaceCategory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'parent_id' })
  parent_id!: string | null;

  @ManyToOne(() => MarketplaceCategory, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent!: MarketplaceCategory | null;

  @Column({ type: 'varchar', length: 150, name: 'name_en' })
  name_en!: string;

  @Column({ type: 'varchar', length: 150, name: 'name_ar' })
  name_ar!: string;

  @Column({ type: 'text', nullable: true, name: 'description_en' })
  description_en!: string | null;

  @Column({ type: 'text', nullable: true, name: 'description_ar' })
  description_ar!: string | null;

  @Column({ type: 'varchar', length: 160 })
  slug!: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'icon_key' })
  icon_key!: string | null;

  @Column({ type: 'int', default: 0, name: 'display_order' })
  display_order!: number;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  is_active!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
