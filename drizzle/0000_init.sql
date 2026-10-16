CREATE TABLE "feature_tbl" (
	"horse_id" bigint NOT NULL,
	"race_id" bigint NOT NULL,
	"jockey_id" varchar(32) NOT NULL,
	"trainer_id" varchar(32) NOT NULL,
	"calculation_result_json" jsonb,
	CONSTRAINT "feature_tbl_horse_id_race_id_pk" PRIMARY KEY("horse_id","race_id")
);
--> statement-breakpoint
CREATE TABLE "horse_tbl" (
	"id" bigint PRIMARY KEY NOT NULL,
	"horse_name" varchar(256) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jockey_tbl" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"jockey_name" varchar(256) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_tbl" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"owner_name" varchar(256) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payoff_tbl" (
	"race_id" bigint NOT NULL,
	"ticket_type" integer NOT NULL,
	"horse_numbers" varchar(16) NOT NULL,
	"payoff" integer NOT NULL,
	"popularity" integer NOT NULL,
	CONSTRAINT "payoff_tbl_race_id_ticket_type_horse_numbers_pk" PRIMARY KEY("race_id","ticket_type","horse_numbers")
);
--> statement-breakpoint
CREATE TABLE "race_info_tbl" (
	"id" bigint PRIMARY KEY NOT NULL,
	"race_name" varchar(256) NOT NULL,
	"date" date NOT NULL,
	"post_time" time,
	"distance" integer,
	"weather" varchar(8),
	"race_number" bigint NOT NULL,
	"run_direction" varchar(8),
	"track_surface" varchar(8),
	"track_condition" varchar(8),
	"track_condition_score" integer,
	"place_detail" varchar(16) NOT NULL,
	"race_grade" integer,
	"race_class" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "race_result_tbl" (
	"race_id" bigint NOT NULL,
	"horse_number" integer NOT NULL,
	"order_of_finish" integer,
	"bracket_number" integer NOT NULL,
	"horse_id" bigint NOT NULL,
	"sex" varchar(8) NOT NULL,
	"age" integer NOT NULL,
	"basis_weight" double precision NOT NULL,
	"jockey_id" varchar(32) NOT NULL,
	"finishing_time" time,
	"margin" varchar(16) NOT NULL,
	"speed_figure" integer,
	"passing_rank" varchar(16) NOT NULL,
	"last_phase" double precision,
	"odds" double precision,
	"popularity" integer,
	"horse_weight" integer,
	"horse_weight_diff" integer,
	"remark" text,
	"stable" varchar(8) NOT NULL,
	"trainer_id" varchar(32) NOT NULL,
	"owner_id" varchar(32) NOT NULL,
	"earning_money" double precision,
	CONSTRAINT "race_result_tbl_race_id_horse_number_pk" PRIMARY KEY("race_id","horse_number")
);
--> statement-breakpoint
CREATE TABLE "trainer_tbl" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"trainer_name" varchar(256) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_tbl" ADD CONSTRAINT "feature_tbl_horse_id_horse_tbl_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horse_tbl"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_tbl" ADD CONSTRAINT "feature_tbl_race_id_race_info_tbl_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."race_info_tbl"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payoff_tbl" ADD CONSTRAINT "payoff_tbl_race_id_race_info_tbl_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."race_info_tbl"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_result_tbl" ADD CONSTRAINT "race_result_tbl_race_id_race_info_tbl_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."race_info_tbl"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_result_tbl" ADD CONSTRAINT "race_result_tbl_horse_id_horse_tbl_id_fk" FOREIGN KEY ("horse_id") REFERENCES "public"."horse_tbl"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_race_name" ON "race_info_tbl" USING btree ("race_name");--> statement-breakpoint
CREATE INDEX "idx_date_post_time" ON "race_info_tbl" USING btree ("date","post_time");--> statement-breakpoint
CREATE INDEX "idx_horse_id" ON "race_result_tbl" USING btree ("horse_id");--> statement-breakpoint
CREATE INDEX "idx_race_horse" ON "race_result_tbl" USING btree ("race_id","horse_id");--> statement-breakpoint
CREATE INDEX "idx_race_jockey" ON "race_result_tbl" USING btree ("race_id","jockey_id");--> statement-breakpoint
CREATE INDEX "idx_race_trainer" ON "race_result_tbl" USING btree ("race_id","trainer_id");--> statement-breakpoint
CREATE INDEX "idx_race_owner" ON "race_result_tbl" USING btree ("race_id","owner_id");