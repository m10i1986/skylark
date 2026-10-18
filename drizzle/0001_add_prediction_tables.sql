CREATE TABLE "prediction_model_tbl" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "prediction_model_tbl_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"circuit" varchar(8) NOT NULL,
	"train_from" date NOT NULL,
	"valid_from" date NOT NULL,
	"test_from" date NOT NULL,
	"data_to" date NOT NULL,
	"parameters_json" jsonb NOT NULL,
	"metrics_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_tbl" (
	"model_id" integer NOT NULL,
	"race_id" bigint NOT NULL,
	"horse_number" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"race_date" date NOT NULL,
	"race_name" varchar(256) NOT NULL,
	"horse_id" bigint,
	"horse_name" varchar(256),
	"odds" double precision NOT NULL,
	"popularity" integer,
	"market_probability" double precision NOT NULL,
	"model_probability" double precision NOT NULL,
	"model_rank" integer NOT NULL,
	"expected_value" double precision NOT NULL,
	"is_value_pick" boolean NOT NULL,
	CONSTRAINT "prediction_tbl_race_id_horse_number_captured_at_pk" PRIMARY KEY("race_id","horse_number","captured_at")
);
--> statement-breakpoint
ALTER TABLE "prediction_tbl" ADD CONSTRAINT "prediction_tbl_model_id_prediction_model_tbl_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."prediction_model_tbl"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_prediction_race_date" ON "prediction_tbl" USING btree ("race_date");