CREATE TABLE `admin_modules` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `module_keys` json NOT NULL,
  `status` tinyint DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_admin` (`admin_id`)
) ;


CREATE TABLE `admins` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `mobile` varchar(15) DEFAULT NULL,
  `address` text,
  `company_name` varchar(255) DEFAULT NULL,
  `company_logo` varchar(255) DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ;


CREATE TABLE `appointments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `client_id` int NOT NULL,
  `staff_id` int DEFAULT NULL,
  `selected_branch` varchar(100) NOT NULL,
  `purpose` varchar(255) DEFAULT NULL,
  `status` enum('pending','assigned','approved','cancelled','delayed','completed') DEFAULT 'pending',
  `appointment_date` date NOT NULL,
  `from_time` time NOT NULL,
  `to_time` time NOT NULL,
  `is_booked` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `admin_id` (`admin_id`),
  KEY `client_id` (`client_id`),
  KEY `staff_id` (`staff_id`),
  CONSTRAINT `appointments_admin_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`) ON DELETE CASCADE,
  CONSTRAINT `appointments_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `appointments_staff_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff` (`id`) ON DELETE SET NULL
) ;


CREATE TABLE `bills` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int DEFAULT NULL,
  `appointment_id` int DEFAULT NULL,
  `client_id` int DEFAULT NULL,
  `staff_id` int DEFAULT NULL,
  `subtotal` decimal(10,2) NOT NULL,
  `tax_amount` decimal(10,2) DEFAULT '0.00',
  `total_amount` decimal(10,2) NOT NULL,
  `bill_status` enum('Pending','Paid','Overdue','Cancelled') DEFAULT 'Pending',
  `notes` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `prescription_id` int DEFAULT NULL,
  `bill_breakdown_json` json DEFAULT NULL,
  `discount_percentage` decimal(5,2) DEFAULT '0.00',
  `discount_amount` decimal(10,2) DEFAULT '0.00',
  `tax_percentage` decimal(5,2) DEFAULT '0.00',
  PRIMARY KEY (`id`),
  KEY `fk_bill_prescription` (`prescription_id`),
  CONSTRAINT `fk_bill_prescription` FOREIGN KEY (`prescription_id`) REFERENCES `prescriptions` (`id`) ON DELETE SET NULL
);


CREATE TABLE `client_staff_reviews` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int DEFAULT NULL,
  `appointment_id` int DEFAULT NULL,
  `staff_id` int DEFAULT NULL,
  `client_id` int DEFAULT NULL,
  `rating` tinyint NOT NULL,
  `review` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `admin_id` (`admin_id`),
  KEY `appointment_id` (`appointment_id`),
  KEY `staff_id` (`staff_id`),
  KEY `client_id` (`client_id`),
  CONSTRAINT `client_staff_reviews_chk_1` CHECK ((`rating` between 1 and 5))
) ;

CREATE TABLE `clients` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `mobile` varchar(15) DEFAULT NULL,
  `address` text,
  `gender` enum('male','female','other') DEFAULT NULL,
  `dob` date DEFAULT NULL,
  `blood_group` enum('A+','A-','B+','B-','AB+','AB-','O+','O-') DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ;

CREATE TABLE `consultation_types` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` text,
  `cost` decimal(10,2) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `admin_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `admin_id` (`admin_id`),
  CONSTRAINT `consultation_types_ibfk_1` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`)
) ;

CREATE TABLE `documents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `client_id` int DEFAULT NULL,
  `staff_id` int DEFAULT NULL,
  `admin_id` int DEFAULT NULL,
  `role` enum('admin','superadmin','doctor','receptionist','client') NOT NULL,
  `file_name` varchar(255) NOT NULL,
  `file` varchar(255) NOT NULL,
  `uploaded_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `client_id` (`client_id`),
  KEY `staff_id` (`staff_id`),
  KEY `admin_id` (`admin_id`)
) ;

CREATE TABLE `forgot_password` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `role` enum('admin','doctor','receptionist','client') NOT NULL,
  `otp` varchar(6) NOT NULL,
  `otp_expiry` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_role` (`user_id`,`role`)
) ;

CREATE TABLE `ipd_admissions` (
  `id` varchar(20) NOT NULL,
  `admin_id` int NOT NULL,
  `client_id` int NOT NULL,
  `doctor_id` int DEFAULT NULL,
  `bed_id` int DEFAULT NULL,
  `branch_name` varchar(225) DEFAULT NULL,
  `admission_date` datetime NOT NULL,
  `discharge_date` datetime DEFAULT NULL,
  `admission_reason` text,
  `discharge_summary` text,
  `status` enum('admitted','discharged','cancelled') DEFAULT 'admitted',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `bed_allocation_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `ipd_bed_allocations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `bed_id` int NOT NULL,
  `start_time` datetime NOT NULL,
  `end_time` datetime DEFAULT NULL,
  `allocation_status` enum('active','completed') DEFAULT 'active',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;


CREATE TABLE `ipd_bed_charges` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `bed_allocation_id` int NOT NULL,
  `bed_id` int DEFAULT NULL,
  `charge_date` date NOT NULL,
  `hours_used` decimal(5,2) DEFAULT '0.00',
  `charge_type` enum('hourly','half_day','full_day') DEFAULT 'full_day',
  `rate_per_day` decimal(10,2) NOT NULL,
  `charge_amount` decimal(10,2) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `ipd_beds` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `room_id` int DEFAULT NULL,
  `bed_number` varchar(20) NOT NULL,
  `bed_charge` decimal(10,2) DEFAULT '0.00',
  `bed_status` enum('available','occupied') DEFAULT 'available',
  `branch_name` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);


CREATE TABLE `ipd_bills` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `total_amount` decimal(10,2) DEFAULT '0.00',
  `discount` decimal(5,2) DEFAULT '0.00',
  `gst_percentage` decimal(5,2) DEFAULT '18.00',
  `taxable_amount` decimal(10,2) DEFAULT '0.00',
  `grand_total` decimal(10,2) DEFAULT '0.00',
  `paid_amount` decimal(10,2) DEFAULT '0.00',
  `balance_amount` decimal(10,2) DEFAULT '0.00',
  `bill_status` enum('pending','partial','paid') DEFAULT 'pending',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `bill_data` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `ipd_doctor_visits` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `doctor_id` int NOT NULL,
  `visit_date` datetime NOT NULL,
  `visit_notes` text,
  `visit_charge` decimal(10,2) DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `ipd_lab_tests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `test_name` varchar(255) NOT NULL,
  `test_date` datetime NOT NULL,
  `result_status` enum('pending','completed') DEFAULT 'pending',
  `test_charge` decimal(10,2) DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `ipd_miscellaneous_charges` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `description` varchar(255) NOT NULL,
  `charge_date` date NOT NULL,
  `charge_amount` decimal(10,2) DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `ipd_nursing_charges` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `charge_date` date NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `charge_amount` decimal(10,2) DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;


CREATE TABLE `ipd_payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `bill_id` int NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `policy_company` varchar(255) DEFAULT NULL,
  `policy_number` varchar(100) DEFAULT NULL,
  `claim_amount` decimal(10,2) DEFAULT '0.00',
  `payment_method` varchar(50) DEFAULT NULL,
  `payment_type` enum('advance','partial','final','refund') DEFAULT 'partial',
  `transaction_id` varchar(255) DEFAULT NULL,
  `receipt_number` varchar(100) NOT NULL,
  `received_by` int DEFAULT NULL,
  `payment_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `notes` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);


CREATE TABLE `ipd_pharmacy_issues` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `medicine_name` varchar(255) NOT NULL,
  `quantity` int NOT NULL,
  `unit_price` decimal(10,2) DEFAULT '0.00',
  `total_price` decimal(10,2) DEFAULT '0.00',
  `issue_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

CREATE TABLE `ipd_procedures` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ipd_id` varchar(20) NOT NULL,
  `procedure_name` varchar(255) NOT NULL,
  `procedure_date` datetime NOT NULL,
  `doctor_id` int DEFAULT NULL,
  `notes` text,
  `procedure_charge` decimal(10,2) DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;


CREATE TABLE `ipd_rooms` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ward_type_id` int DEFAULT NULL,
  `room_number` varchar(50) NOT NULL,
  `branch_name` varchar(225) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `ipd_ward_type` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `ward_type_name` varchar(100) NOT NULL,
  `branch_name` varchar(225) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `leave_requests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int DEFAULT NULL,
  `staff_id` int DEFAULT NULL,
  `leave_type` enum('Sick','Casual','Paid','Unpaid','Maternity','Other') NOT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `reason` text,
  `status` enum('Pending','Approved','Rejected') DEFAULT 'Pending',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `login_otp` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `role` enum('admin','client','doctor','receptionist') NOT NULL,
  `otp` varchar(6) NOT NULL,
  `otp_expiry` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_role` (`user_id`,`role`)
) ;


CREATE TABLE `medicines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `medicine_name` varchar(255) NOT NULL,
  `type` varchar(100) DEFAULT NULL,
  `strength` varchar(100) DEFAULT NULL,
  `unit` varchar(50) DEFAULT NULL,
  `quantity` int DEFAULT '0',
  `amount` int DEFAULT '1',
  `when_to_take` json DEFAULT NULL,
  `duration` varchar(100) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `admin_id` int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `modules` (
  `id` int NOT NULL AUTO_INCREMENT,
  `module_name` varchar(100) DEFAULT NULL,
  `module_key` varchar(100) DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `module_key` (`module_key`)
) ;

CREATE TABLE `notification_receivers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `notification_id` int NOT NULL,
  `receiver_role` enum('admin','doctor','receptionist','client') NOT NULL,
  `receiver_id` int NOT NULL,
  `is_read` tinyint(1) DEFAULT '0',
  `read_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `notifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `sender_role` enum('client','admin','receptionist','doctor') NOT NULL,
  `sender_id` int DEFAULT NULL,
  `title` varchar(255) NOT NULL,
  `message` text NOT NULL,
  `type` varchar(50) DEFAULT 'general',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int DEFAULT NULL,
  `bill_id` int DEFAULT NULL,
  `appointment_id` int DEFAULT NULL,
  `client_id` int DEFAULT NULL,
  `amount` decimal(10,2) NOT NULL,
  `transaction_id` varchar(255) DEFAULT NULL,
  `payment_method` varchar(50) DEFAULT NULL,
  `payment_date` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `admin_id` (`admin_id`),
  KEY `bill_id` (`bill_id`),
  KEY `appointment_id` (`appointment_id`),
  KEY `client_id` (`client_id`)
) ;

CREATE TABLE `prescriptions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `patient_id` int NOT NULL,
  `doctor_id` int DEFAULT NULL,
  `admin_id` int NOT NULL,
  `appointment_id` int DEFAULT NULL,
  `consultation_type_json` json DEFAULT NULL,
  `medicines_json` json DEFAULT NULL,
  `tests_json` json DEFAULT NULL,
  `notes` text,
  `description` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `prescriptions_appointment_fk` (`appointment_id`),
  CONSTRAINT `prescriptions_appointment_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE `role_modules` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `role` enum('doctor','receptionist','client') NOT NULL,
  `module_keys` json NOT NULL,
  `status` tinyint DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_admin_role` (`admin_id`,`role`)
) ;


CREATE TABLE `staff` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `mobile` varchar(15) DEFAULT NULL,
  `address` text,
  `role` enum('receptionist','doctor') NOT NULL,
  `branch` varchar(255) DEFAULT NULL,
  `qualification` varchar(255) DEFAULT NULL,
  `date_of_joining` date DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `profile_photo` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `admin_id` (`admin_id`),
  CONSTRAINT `staff_ibfk_1` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`) ON DELETE CASCADE
);

CREATE TABLE `staff_attendance` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `staff_id` int NOT NULL,
  `date` date NOT NULL,
  `clock_in` time DEFAULT NULL,
  `clock_out` time DEFAULT NULL,
  `total_hours` decimal(5,2) DEFAULT '0.00',
  `status` enum('present','absent','leave','half_day') DEFAULT 'present',
  `reason` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_staff_date` (`staff_id`,`date`),
  KEY `admin_id` (`admin_id`),
  KEY `staff_id` (`staff_id`),
  CONSTRAINT `attendance_admin_fk` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`) ON DELETE CASCADE,
  CONSTRAINT `attendance_staff_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff` (`id`) ON DELETE CASCADE
) ;


CREATE TABLE `staff_time_slots` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int NOT NULL,
  `staff_id` int DEFAULT NULL,
  `slot_date` date NOT NULL,
  `slot_time_from` time NOT NULL,
  `slot_time_to` time NOT NULL,
  `is_booked` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

CREATE TABLE `tests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `test_name` varchar(255) NOT NULL,
  `test_type` varchar(225) DEFAULT NULL,
  `description` text,
  `admin_id` int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ;

