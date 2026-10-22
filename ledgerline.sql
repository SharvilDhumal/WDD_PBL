-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Oct 22, 2026 at 03:25 PM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `ledgerline`
--

-- --------------------------------------------------------

--
-- Table structure for table `transactions`
--

CREATE TABLE `transactions` (
  `id` int(11) NOT NULL,
  `type` varchar(10) NOT NULL,
  `description` varchar(255) NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `category` varchar(50) NOT NULL,
  `tx_date` date NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `transactions`
--

INSERT INTO `transactions` (`id`, `type`, `description`, `amount`, `category`, `tx_date`, `created_at`) VALUES
(1, 'income', 'salary', 100000.00, 'Salary', '2026-01-01', '2026-10-22 12:52:19'),
(2, 'expense', 'food', 500.00, 'Food', '2026-01-05', '2026-10-22 12:52:39'),
(3, 'income', 'Salary', 25000.00, 'Salary', '2026-10-01', '2026-10-22 12:59:42'),
(4, 'expense', 'Chai', 20.00, 'Food', '2026-10-22', '2026-10-22 12:59:42'),
(5, 'expense', 'Bus ticket', 50.00, 'Transport', '2026-10-22', '2026-10-22 12:59:42'),
(6, 'income', 'Salary', 25000.00, 'Salary', '2026-10-01', '2026-10-22 13:01:16'),
(7, 'expense', 'Chai', 20.00, 'Food', '2026-10-22', '2026-10-22 13:01:16'),
(8, 'expense', 'Bus ticket', 50.00, 'Transport', '2026-10-22', '2026-10-22 13:01:16'),
(9, 'income', 'salary', 100000.00, 'Salary', '2026-01-01', '2026-10-22 13:02:28'),
(10, 'expense', 'shopping', 500.00, 'Shopping', '2026-01-02', '2026-10-22 13:02:58');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `transactions`
--
ALTER TABLE `transactions`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `transactions`
--
ALTER TABLE `transactions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=11;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
