UPDATE `users` SET `username` = `username` || '-' || `id` WHERE `username` IS NOT NULL AND EXISTS (SELECT 1 FROM `users` AS `earlier` WHERE `earlier`.`username` IS NOT NULL AND lower(`earlier`.`username`) = lower(`users`.`username`) AND `earlier`.`id` < `users`.`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_lower_idx` ON `users` (lower(`username`));
