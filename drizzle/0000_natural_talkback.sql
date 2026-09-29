CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TYPE "public"."vote_value" AS ENUM('confirm', 'reject');--> statement-breakpoint
CREATE TABLE "animals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_ru" text NOT NULL,
	"name_en" text NOT NULL,
	"icon" text NOT NULL,
	CONSTRAINT "animals_slug_not_blank" CHECK (length(btrim("animals"."slug")) > 0),
	CONSTRAINT "animals_name_ru_not_blank" CHECK (length(btrim("animals"."name_ru")) > 0),
	CONSTRAINT "animals_name_en_not_blank" CHECK (length(btrim("animals"."name_en")) > 0),
	CONSTRAINT "animals_icon_not_blank" CHECK (length(btrim("animals"."icon")) > 0)
);
--> statement-breakpoint
CREATE TABLE "client_issuance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"browser_family" varchar(100),
	"os_family" varchar(100),
	"language" varchar(50),
	"was_issued" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "client_issuance_events_ip_hash_sha256" CHECK ("client_issuance_events"."ip_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "client_issuance_events_expiry" CHECK ("client_issuance_events"."expires_at" > "client_issuance_events"."created_at")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_token_hash_sha256" CHECK ("clients"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "observation_idempotency" (
	"client_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"observation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "observation_idempotency_client_key_pk" PRIMARY KEY("client_id","idempotency_key"),
	CONSTRAINT "observation_idempotency_request_hash_sha256" CHECK ("observation_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "observation_idempotency_expiry" CHECK ("observation_idempotency"."expires_at" = "observation_idempotency"."created_at" + interval '24 hours')
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"location" geometry(Point,4326) NOT NULL,
	"location_label" varchar(300),
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" varchar(200),
	CONSTRAINT "observations_location_not_empty" CHECK (NOT ST_IsEmpty("observations"."location")),
	CONSTRAINT "observations_longitude_range" CHECK (ST_X("observations"."location") BETWEEN -180 AND 180),
	CONSTRAINT "observations_latitude_range" CHECK (ST_Y("observations"."location") BETWEEN -90 AND 90),
	CONSTRAINT "observations_time_range" CHECK (
    "observations"."observed_at" <= "observations"."created_at"
    AND "observations"."observed_at" > "observations"."created_at" - interval '30 days'
  ),
	CONSTRAINT "observations_location_label_not_blank" CHECK (
    "observations"."location_label" IS NULL OR length(btrim("observations"."location_label")) > 0
  ),
	CONSTRAINT "observations_note_not_blank" CHECK ("observations"."note" IS NULL OR length(btrim("observations"."note")) > 0)
);
--> statement-breakpoint
CREATE TABLE "publication_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"observation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"value" "vote_value" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_observation_client_pk" PRIMARY KEY("observation_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "observation_idempotency" ADD CONSTRAINT "observation_idempotency_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_idempotency" ADD CONSTRAINT "observation_idempotency_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_events" ADD CONSTRAINT "publication_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "animals_slug_unique" ON "animals" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "client_issuance_events_ip_created_at_idx" ON "client_issuance_events" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "client_issuance_events_expires_at_idx" ON "client_issuance_events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_token_hash_unique" ON "clients" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "observation_idempotency_expires_at_idx" ON "observation_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "observations_location_gist" ON "observations" USING gist ("location");--> statement-breakpoint
CREATE INDEX "observations_animal_observed_at_idx" ON "observations" USING btree ("animal_id","observed_at");--> statement-breakpoint
CREATE INDEX "observations_observed_at_idx" ON "observations" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "publication_events_client_published_at_idx" ON "publication_events" USING btree ("client_id","published_at");--> statement-breakpoint
CREATE INDEX "publication_events_published_at_idx" ON "publication_events" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "votes_client_id_idx" ON "votes" USING btree ("client_id");
