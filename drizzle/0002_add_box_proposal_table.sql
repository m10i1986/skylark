CREATE TABLE "box_proposal_tbl" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "box_proposal_tbl_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_id" integer NOT NULL,
	"race_id" bigint NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"race_date" date NOT NULL,
	"race_name" varchar(256) NOT NULL,
	"source" varchar(8) NOT NULL,
	"ai_model" varchar(64),
	"max_tickets" integer NOT NULL,
	"horse_numbers" varchar(32) NOT NULL,
	"ticket_count" integer NOT NULL,
	"hit_probability" double precision NOT NULL,
	"best_hit_probability" double precision NOT NULL,
	"baseline_horse_numbers" varchar(32) NOT NULL,
	"baseline_hit_probability" double precision NOT NULL,
	"reason" text NOT NULL,
	"caution" text
);
--> statement-breakpoint
ALTER TABLE "box_proposal_tbl" ADD CONSTRAINT "box_proposal_tbl_model_id_prediction_model_tbl_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."prediction_model_tbl"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_box_proposal_race_date" ON "box_proposal_tbl" USING btree ("race_date");--> statement-breakpoint
CREATE INDEX "idx_box_proposal_race" ON "box_proposal_tbl" USING btree ("race_id");