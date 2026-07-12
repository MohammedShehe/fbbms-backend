-- MySQL dump 10.13  Distrib 8.0.44, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: fbbms
-- ------------------------------------------------------
-- Server version	5.5.5-10.4.32-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `scents_inventory`
--

DROP TABLE IF EXISTS `scents_inventory`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `scents_inventory` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `category` varchar(150) NOT NULL,
  `stock_quantity` decimal(12,2) NOT NULL DEFAULT 0.00,
  `unit` varchar(50) NOT NULL,
  `last_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `scents_inventory`
--

LOCK TABLES `scents_inventory` WRITE;
/*!40000 ALTER TABLE `scents_inventory` DISABLE KEYS */;
/*!40000 ALTER TABLE `scents_inventory` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `scents_sales`
--

DROP TABLE IF EXISTS `scents_sales`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `scents_sales` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `sale_date` date NOT NULL,
  `customer_name` varchar(150) NOT NULL,
  `item_name` varchar(150) NOT NULL,
  `category` enum('Perfume - Men','Perfume - Women','Unisex Perfume','Body Spray','Oud & Bakhoor','Deodorant','Air Freshener','Other') NOT NULL,
  `quantity` int(11) NOT NULL,
  `unit_price` decimal(12,2) NOT NULL,
  `total_price` decimal(12,2) NOT NULL,
  `notes` text DEFAULT NULL,
  `created_by` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `scents_sales_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `scents_sales`
--

LOCK TABLES `scents_sales` WRITE;
/*!40000 ALTER TABLE `scents_sales` DISABLE KEYS */;
INSERT INTO `scents_sales` VALUES (1,'2026-07-12','Sarah Johnson','Chanel No. 5 Perfume','Perfume - Women',3,85000.00,255000.00,'Gift wrapping requested',2,'2026-07-11 21:04:07');
/*!40000 ALTER TABLE `scents_sales` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `sports_inventory`
--

DROP TABLE IF EXISTS `sports_inventory`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sports_inventory` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `category` varchar(150) NOT NULL,
  `stock_quantity` decimal(12,2) NOT NULL DEFAULT 0.00,
  `unit` varchar(50) NOT NULL,
  `last_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `category` (`category`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `sports_inventory`
--

LOCK TABLES `sports_inventory` WRITE;
/*!40000 ALTER TABLE `sports_inventory` DISABLE KEYS */;
INSERT INTO `sports_inventory` VALUES (1,'Football',50.00,'pcs','2026-07-12 18:56:04');
/*!40000 ALTER TABLE `sports_inventory` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `sports_sales`
--

DROP TABLE IF EXISTS `sports_sales`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sports_sales` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `sale_date` date NOT NULL,
  `customer_name` varchar(150) NOT NULL,
  `item_name` varchar(150) NOT NULL,
  `category` enum('Football','Basketball','Volleyball','Netball','Gym Equipment','Jerseys & Apparel','Footwear','Accessories','Other') NOT NULL,
  `quantity` int(11) NOT NULL,
  `unit_price` decimal(12,2) NOT NULL,
  `total_price` decimal(12,2) NOT NULL,
  `notes` text DEFAULT NULL,
  `created_by` int(11) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `sports_sales_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `sports_sales`
--

LOCK TABLES `sports_sales` WRITE;
/*!40000 ALTER TABLE `sports_sales` DISABLE KEYS */;
INSERT INTO `sports_sales` VALUES (1,'2026-07-10','John Peter','Adidas Football','Football',5,35000.00,175000.00,'Paid Cash',1,'2026-07-10 15:48:57');
/*!40000 ALTER TABLE `sports_sales` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email` varchar(100) NOT NULL,
  `password` varchar(255) NOT NULL,
  `role` enum('super_manager','sports_manager','scents_manager') NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'sports@fourbrothers.online','$2b$10$fjadj4Sx70wdWKp4e1CX7.wCXRfB8QZVXN3H87XJgarY6jY7IKqma','sports_manager','2026-07-10 15:33:00'),(2,'scents@fourbrothers.online','$2b$10$fjadj4Sx70wdWKp4e1CX7.wCXRfB8QZVXN3H87XJgarY6jY7IKqma','scents_manager','2026-07-10 15:33:00'),(3,'manager@fourbrothers.online','$2b$10$fjadj4Sx70wdWKp4e1CX7.wCXRfB8QZVXN3H87XJgarY6jY7IKqma','super_manager','2026-07-10 15:33:00');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-13  0:29:23
